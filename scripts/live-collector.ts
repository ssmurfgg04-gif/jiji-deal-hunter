#!/usr/bin/env bun
/**
 * Live Collector — respectful weekly Jiji scraper.
 *
 * This script is the production data source for the temporal ML pipeline.
 * It replaces the archived-Wayback data source with live captures so the
 * `motivated_seller` target can be computed from real price drops instead
 * of historical snapshots.
 *
 * Pacing: 1 request / 3 seconds (polite; Cloudflare-friendly).
 * UA rotation: handled by jiji-client.ts (7-UA pool).
 * Retry: 1 retry on transient errors + 429/503 backoff (jiji-client.ts).
 *
 * Output: writes PriceSnapshot rows (source="live") for every (item, price)
 * captured. Existing snapshots are upserted — running this weekly produces
 * a price time series per item with no duplicates.
 *
 * Usage:
 *   bun scripts/live-collector.ts                       # default top categories per market
 *   bun scripts/live-collector.ts --market=ke           # single market
 *   bun scripts/live-collector.ts --category=3:vehicles # single category
 *   bun scripts/live-collector.ts --max-pages=2         # paginate deeper
 *   bun scripts/live-collector.ts --queries="iphone,macbook"  # query mode
 *
 * Recommended cron: weekly (Sunday 03:00 server time).
 *   0 3 * * 0 cd /app && bun scripts/live-collector.ts >> logs/live-collector.log 2>&1
 */

import { jiji, MARKETS, type MarketId } from "../src/lib/jiji-client";
import { db } from "../src/lib/db";
import { checkpointDb } from "../src/lib/db";

interface Args {
  market?: MarketId;
  category?: { catId: number; slug: string };
  maxPages?: number;
  queries?: string[];
}

function parseArgs(): Args {
  const args: Args = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--market=")) args.market = a.slice(9) as MarketId;
    else if (a.startsWith("--category=")) {
      const [id, slug] = a.slice(11).split(":");
      args.category = { catId: parseInt(id, 10), slug };
    } else if (a.startsWith("--max-pages=")) args.maxPages = parseInt(a.slice(12), 10);
    else if (a.startsWith("--queries=")) args.queries = a.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

const DEFAULT_TOP_CATEGORIES: Record<MarketId, Array<{ catId: number; slug: string }>> = {
  ke: [
    { catId: 3, slug: "vehicles" },
    { catId: 49, slug: "phones-tablets" },
    { catId: 89, slug: "electronics" },
    { catId: 105, slug: "computers-laptops" },
  ],
  ng: [
    { catId: 3, slug: "vehicles" },
    { catId: 49, slug: "phones-tablets" },
  ],
  gh: [{ catId: 3, slug: "vehicles" }],
  tz: [{ catId: 3, slug: "vehicles" }],
  ug: [{ catId: 3, slug: "vehicles" }],
};

async function captureSnapshot(marketId: MarketId, item: any): Promise<void> {
  const captureTimestamp = new Date();
  try {
    await db.priceSnapshot.upsert({
      where: {
        marketId_itemId_captureTimestamp: {
          marketId,
          itemId: item.guid,
          captureTimestamp,
        },
      },
      create: {
        marketId,
        itemId: item.guid,
        price: BigInt(item.price),
        currency: item.currency,
        categorySlug: item.category,
        captureTimestamp,
        captureUrl: item.url,
        source: "live",
        pageTitle: item.title,
      },
      update: {}, // snapshot already exists — no-op
    });
  } catch (e: any) {
    // P2002 = unique constraint — already captured this exact (item, ts).
    // Since we generate captureTimestamp at call time, this shouldn't happen
    // across runs, but it can happen if two parallel scrapers race.
    if (e?.code !== "P2002") {
      console.warn(`[snapshot] failed for ${item.id}:`, e?.message);
    }
  }
}

async function main() {
  const args = parseArgs();
  const startedAt = Date.now();
  let snapshotsWritten = 0;
  let itemsSeen = 0;
  let blockedCount = 0;

  const marketIds: MarketId[] = args.market ? [args.market] : (MARKETS.map((m) => m.id) as MarketId[]);

  console.log(`[live-collector] Starting — markets: ${marketIds.join(", ")}`);

  for (const marketId of marketIds) {
    console.log(`[${marketId}] Collecting...`);

    if (args.queries && args.queries.length > 0) {
      for (const q of args.queries) {
        const result = await jiji.search(marketId, { q });
        if (!result) {
          blockedCount++;
          console.warn(`[${marketId}] Search BLOCKED for "${q}"`);
          continue;
        }
        for (const item of result.items) {
          itemsSeen++;
          await captureSnapshot(marketId, item);
          snapshotsWritten++;
        }
        console.log(`[${marketId}] "${q}": ${result.items.length} items captured`);
      }
    } else {
      const cats = args.category ? [args.category] : DEFAULT_TOP_CATEGORIES[marketId] ?? [];
      const maxPages = args.maxPages ?? 1;
      for (const cat of cats) {
        const result = await jiji.getCategoryFeed(marketId, cat.catId, cat.slug, { maxPages });
        if (!result) {
          blockedCount++;
          console.warn(`[${marketId}] Category ${cat.slug} BLOCKED`);
          continue;
        }
        for (const item of result.items) {
          itemsSeen++;
          await captureSnapshot(marketId, item);
          snapshotsWritten++;
        }
        console.log(`[${marketId}] ${cat.slug}: ${result.items.length} items captured`);
      }
    }
  }

  await checkpointDb();
  const durationMs = Date.now() - startedAt;
  console.log(
    `[live-collector] Done — ${snapshotsWritten} snapshots, ${itemsSeen} items seen, ` +
    `${blockedCount} blocked, ${durationMs}ms`
  );

  if (blockedCount > 0 && snapshotsWritten === 0) {
    console.error("[live-collector] FATAL: All requests blocked. Check WAF status or proxy pool.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[live-collector] FATAL:", e);
    process.exit(1);
  });
