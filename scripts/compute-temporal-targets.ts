#!/usr/bin/env bun
/**
 * Compute Temporal Targets — recompute motivated_seller / stale_listing /
 * flip_opportunity flags on every CanonicalItem based on its priceHistory.
 *
 * This is the post-collection pass that runs after live-collector.ts has
 * captured new PriceSnapshot rows. Without it, the temporal labels stay
 * frozen at whatever the last entity-resolution pass set.
 *
 * Run weekly after live-collector.ts (cron-weekly.sh calls this automatically).
 * Can also be run manually after `bun scripts/resolve-entities.ts`.
 *
 * Target rules (must match resolve-entities.ts and train-xgboost-v3.py):
 *
 *   motivated_seller = price_delta_pct < -0.20
 *                      AND days_listed >= 14
 *                      AND capture_count >= 3
 *                      AND last_price > 0
 *                      AND no >10x price jumps between consecutive captures
 *
 *   stale_listing    = days_listed >= 14
 *                      AND price_delta_pct >= -0.05  (flat or rising)
 *                      AND capture_count >= 3
 *
 *   flip_opportunity = motivated_seller AND seller.advertsCount > 50
 *
 * Usage:
 *   bun scripts/compute-temporal-targets.ts                # all items
 *   bun scripts/compute-temporal-targets.ts --market=ke    # single market
 *   bun scripts/compute-temporal-targets.ts --dry-run      # report only, no writes
 */

import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

const db = new PrismaClient();

interface Args {
  market?: string;
  dryRun?: boolean;
}

function parseArgs(): Args {
  const args: Args = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--market=")) args.market = a.slice(9);
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

interface PricePoint {
  t: string;
  price: string; // BigInt serialized as string
}

function hasCurrencyAnomaly(prices: number[]): boolean {
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev <= 0 || cur <= 0) continue;
    if (cur / prev > 10 || prev / cur > 10) return true;
  }
  return false;
}

function computeTargets(priceHistory: PricePoint[], sellerAdverts: number): {
  motivated: boolean;
  stale: boolean;
  flip: boolean;
  deltaPct: number;
} {
  if (priceHistory.length < 3) {
    return { motivated: false, stale: false, flip: false, deltaPct: 0 };
  }

  const prices = priceHistory.map((p) => Number(BigInt(p.price)));
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (first <= 0 || last <= 0) {
    return { motivated: false, stale: false, flip: false, deltaPct: 0 };
  }

  const deltaPct = (last - first) / first;

  const firstTs = new Date(priceHistory[0].t).getTime();
  const lastTs = new Date(priceHistory[priceHistory.length - 1].t).getTime();
  const daysListed = Math.max(0, Math.floor((lastTs - firstTs) / 86400000));

  if (daysListed < 14) {
    return { motivated: false, stale: false, flip: false, deltaPct };
  }

  if (hasCurrencyAnomaly(prices)) {
    return { motivated: false, stale: false, flip: false, deltaPct };
  }

  const motivated = deltaPct < -0.20;
  const stale = deltaPct >= -0.05;
  const flip = motivated && sellerAdverts > 50;

  return { motivated, stale, flip, deltaPct };
}

async function main() {
  const args = parseArgs();
  console.log(`[temporal-targets] Starting${args.dryRun ? " (DRY RUN)" : ""}...`);

  const where: Prisma.CanonicalItemWhereInput = args.market ? { marketId: args.market } : {};

  const items = await db.canonicalItem.findMany({
    where,
    // No `include` — we fetch Listing + Seller separately below to avoid N+1.
  });

  // Fetch seller adverts counts in one pass to avoid N+1
  const listingIds = items.map((i) => i.id);
  const listings = await db.listing.findMany({
    where: { id: { in: listingIds } },
    select: { id: true, sellerId: true },
  });
  const sellerIds = [...new Set(listings.map((l) => l.sellerId))];
  const sellers = await db.seller.findMany({
    where: { id: { in: sellerIds } },
    select: { id: true, advertsCount: true },
  });
  const sellerAdverts = new Map(sellers.map((s) => [s.id, s.advertsCount]));
  const listingSeller = new Map(listings.map((l) => [l.id, l.sellerId]));

  console.log(`[temporal-targets] Processing ${items.length} canonical items...`);

  let updated = 0;
  let motivated = 0;
  let stale = 0;
  let flip = 0;
  const batchSize = 100;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let history: PricePoint[] = [];
    try {
      history = JSON.parse(item.priceHistory || "[]");
    } catch {
      // malformed JSON — skip, leave existing flags
      continue;
    }

    const sellerId = listingSeller.get(item.id);
    const adverts = sellerId ? (sellerAdverts.get(sellerId) ?? 0) : 0;

    const { motivated: m, stale: s, flip: f, deltaPct } = computeTargets(history, adverts);

    if (m) motivated++;
    if (s) stale++;
    if (f) flip++;

    if (
      item.motivatedSeller !== m ||
      item.staleListing !== s ||
      item.flipOpportunity !== f ||
      Math.abs((item.priceDeltaPct ?? 0) - deltaPct) > 0.0001
    ) {
      updated++;
      if (!args.dryRun) {
        await db.canonicalItem.update({
          where: { id: item.id },
          data: {
            motivatedSeller: m,
            staleListing: s,
            flipOpportunity: f,
            priceDeltaPct: deltaPct,
            updatedAt: new Date(),
          },
        });
      }
    }

    if ((i + 1) % batchSize === 0) {
      console.log(
        `[temporal-targets] Progress: ${i + 1}/${items.length} ` +
        `(updated=${updated}, motivated=${motivated}, stale=${stale}, flip=${flip})`
      );
    }
  }

  console.log(`\n[temporal-targets] Done.`);
  console.log(`  Processed:       ${items.length}`);
  console.log(`  Updated:         ${updated}${args.dryRun ? " (would update)" : ""}`);
  console.log(`  motivatedSeller: ${motivated}`);
  console.log(`  staleListing:    ${stale}`);
  console.log(`  flipOpportunity: ${flip}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[temporal-targets] FATAL:", e);
  process.exit(1);
});
