#!/usr/bin/env bun
/**
 * Weekly Revisit — re-scrape active listings to build price history.
 *
 * After `live-collector.ts` has been running for a few weeks, we have a
 * pool of "active" CanonicalItems. This script:
 *   1. Queries all PriceSnapshot items captured in the last 14 days.
 *   2. Re-fetches each item's live page (via jiji.getItemDetail).
 *   3. Writes a NEW PriceSnapshot row for the current price.
 *
 * Over 4+ weeks, this builds a price time series per item with enough
 * data points to compute meaningful `priceDeltaPct` and detect motivated
 * sellers (price drops > 20% sustained > 14 days).
 *
 * Pacing: 1 req / 3 sec — same as live-collector. Honors Retry-After.
 *
 * Usage:
 *   bun scripts/live-revisit.ts                 # revisit all markets
 *   bun scripts/live-revisit.ts --market=ke     # single market
 *   bun scripts/live-revisit.ts --days=7        # only items seen in last 7 days
 *   bun scripts/live-revisit.ts --limit=500     # cap items per market
 *
 * Recommended cron: weekly (Wednesday 03:00 server time).
 *   0 3 * * 3 cd /app && bun scripts/live-revisit.ts >> logs/live-revisit.log 2>&1
 */

import { jiji, MARKETS, type MarketId } from "../src/lib/jiji-client";
import { db } from "../src/lib/db";
import { checkpointDb } from "../src/lib/db";

interface Args {
  market?: MarketId;
  days?: number;
  limit?: number;
}

function parseArgs(): Args {
  const args: Args = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--market=")) args.market = a.slice(9) as MarketId;
    else if (a.startsWith("--days=")) args.days = parseInt(a.slice(7), 10);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
  }
  return args;
}

async function revisitItem(marketId: MarketId, itemId: string): Promise<{
  revisited: boolean;
  priceChanged: boolean;
  blocked: boolean;
}> {
  const result = await jiji.getItemDetail(marketId, itemId);
  if (!result) {
    return { revisited: false, priceChanged: false, blocked: true };
  }

  const captureTimestamp = new Date();
  try {
    await db.priceSnapshot.create({
      data: {
        marketId,
        itemId,
        price: BigInt(result.price),
        currency: result.currency,
        categorySlug: result.category,
        captureTimestamp,
        captureUrl: result.url,
        source: "live",
        pageTitle: result.title,
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      // Already captured this exact timestamp — skip.
      return { revisited: false, priceChanged: false, blocked: false };
    }
    throw e;
  }

  // Compare to the most recent prior snapshot
  const prior = await db.priceSnapshot.findFirst({
    where: {
      marketId,
      itemId,
      captureTimestamp: { lt: captureTimestamp },
    },
    orderBy: { captureTimestamp: "desc" },
  });

  const priceChanged = prior != null && BigInt(prior.price) !== BigInt(result.price);
  return { revisited: true, priceChanged, blocked: false };
}

async function main() {
  const args = parseArgs();
  const days = args.days ?? 14;
  const limit = args.limit ?? 1000;
  const startedAt = Date.now();
  const since = new Date(Date.now() - days * 86400_000);

  let revisited = 0;
  let priceChanged = 0;
  let blocked = 0;
  let totalItems = 0;

  const marketIds: MarketId[] = args.market ? [args.market] : (MARKETS.map((m) => m.id) as MarketId[]);

  console.log(`[live-revisit] Starting — markets: ${marketIds.join(", ")}, since: ${since.toISOString()}`);

  for (const marketId of marketIds) {
    // Find distinct itemIds that have at least one snapshot in the last N days.
    const items = await db.priceSnapshot.findMany({
      where: { marketId, captureTimestamp: { gte: since } },
      select: { itemId: true },
      distinct: ["itemId"],
      take: limit,
    });
    console.log(`[${marketId}] Revisiting ${items.length} items...`);

    for (const { itemId } of items) {
      totalItems++;
      const result = await revisitItem(marketId, itemId);
      if (result.blocked) blocked++;
      if (result.revisited) {
        revisited++;
        if (result.priceChanged) priceChanged++;
      }
    }
    console.log(
      `[${marketId}] Done — revisited: ${revisited}, price changes: ${priceChanged}, blocked: ${blocked}`
    );
  }

  await checkpointDb();
  const durationMs = Date.now() - startedAt;
  console.log(
    `[live-revisit] Done — total items: ${totalItems}, revisited: ${revisited}, ` +
    `price changes: ${priceChanged}, blocked: ${blocked}, ${durationMs}ms`
  );

  if (blocked === totalItems && totalItems > 0) {
    console.error("[live-revisit] FATAL: All revisits blocked. Check WAF status or proxy pool.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[live-revisit] FATAL:", e);
    process.exit(1);
  });
