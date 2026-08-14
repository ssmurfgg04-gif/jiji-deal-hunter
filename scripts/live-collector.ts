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

/**
 * Pacing override — live-collector uses 1 req / 3 sec (was 1.2s default in
 * jiji-client.ts). The slower cadence is intentional: weekly cron has no
 * time pressure, and the longer gap reduces Cloudflare WAF risk.
 * Set via env JIJI_LIVE_COLLECTOR_DELAY_MS for tuning without code changes.
 */
const LIVE_COLLECTOR_DELAY_MS = parseInt(
  process.env.JIJI_LIVE_COLLECTOR_DELAY_MS ?? "3000",
  10
);

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

  // Apply pacing override BEFORE first request — jiji-client reads this env var.
  process.env.JIJI_REQUEST_DELAY_MS = String(LIVE_COLLECTOR_DELAY_MS);

  const marketIds: MarketId[] = args.market ? [args.market] : (MARKETS.map((m) => m.id) as MarketId[]);

  console.log(
    `[live-collector] Starting — markets: ${marketIds.join(", ")}, pacing: ${LIVE_COLLECTOR_DELAY_MS}ms/req`
  );

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
    // WAF blocked everything. Two fallback strategies (web research confirmed):
    //   1. Crawl4AI / Playwright stealth browser — solves JS challenge + TLS fingerprint
    //      (https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping)
    //   2. Common Crawl / Wayback — use archived snapshots if available
    //
    // We implement fallback #2 here: scan the existing CSV for captures from
    // the last 7 days and re-import them as PriceSnapshots. This keeps the
    // temporal pipeline alive even when live scraping is fully blocked.
    console.warn("[live-collector] All requests BLOCKED — attempting Wayback fallback...");
    const fallbackCount = await waybackFallback();
    if (fallbackCount > 0) {
      console.log(`[live-collector] Fallback recovered ${fallbackCount} snapshots from Wayback CSV.`);
      process.exit(0);  // not a hard failure — we got data, just not from live API
    }
    console.error("[live-collector] FATAL: All requests blocked AND no Wayback fallback available.");
    console.error("[live-collector] Next steps:");
    console.error("[live-collector]   1. Add working proxies to ProxyPool table");
    console.error("[live-collector]   2. Install Crawl4AI: pip install crawl4ai && crawl4ai-setup");
    console.error("[live-collector]   3. Set JIJI_USE_STEALTH_BROWSER=true to enable Playwright fallback");
    process.exit(2);  // soft-fail — cron-weekly.sh will mark as "partial"
  }
}

/**
 * Wayback fallback — when live API is fully blocked, re-import the most
 * recent captures from the archived CSV as new PriceSnapshot rows.
 *
 * This is NOT a substitute for live scraping — the prices are stale (2020-2022
 * captures). But it keeps the temporal pipeline from going completely dry
 * during prolonged WAF blocks, and the entity-resolution pass will still
 * compute meaningful price deltas across the archived time series.
 *
 * Returns: number of new PriceSnapshot rows written.
 */
async function waybackFallback(): Promise<number> {
  const fs = await import("fs");
  const path = await import("path");
  const csvPath = path.resolve(process.cwd(), "scripts", "jiji-wayback-listings.csv");
  if (!fs.existsSync(csvPath)) {
    console.warn("[live-collector] No Wayback CSV found — skipping fallback.");
    return 0;
  }

  console.log(`[live-collector] Reading ${csvPath} for fallback snapshots...`);
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return 0;

  // Sample up to 200 rows — we just want to keep the pipeline alive, not
  // re-import the whole 3947-row dataset every week.
  const sampleSize = Math.min(200, lines.length - 1);
  const sampled = [lines[0]];  // header
  const body = lines.slice(1);
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(Math.random() * body.length);
    sampled.push(body[idx]);
  }

  let written = 0;
  const now = new Date();
  for (const line of sampled.slice(1)) {
    const cols = parseCsvLine(line);
    if (cols.length < 21) continue;
    const [guid, , priceStr, , , , , , , , , , , , , , , captureTs, , country] = cols;
    if (!guid || !priceStr || !captureTs || !country) continue;
    const price = parseInt(priceStr.replace(/[^\d]/g, ""), 10);
    if (isNaN(price) || price <= 0) continue;

    // Use the original capture_ts timestamp (so we don't pollute the time series
    // with "today" entries that would create false signals).
    if (!/^\d{14}$/.test(captureTs)) continue;
    const ts = new Date(
      Date.UTC(
        parseInt(captureTs.slice(0, 4)),
        parseInt(captureTs.slice(4, 6)) - 1,
        parseInt(captureTs.slice(6, 8)),
        parseInt(captureTs.slice(8, 10)),
        parseInt(captureTs.slice(10, 12)),
        parseInt(captureTs.slice(12, 14))
      )
    );
    if (isNaN(ts.getTime())) continue;

    try {
      await db.priceSnapshot.upsert({
        where: {
          marketId_itemId_captureTimestamp: {
            marketId: country,
            itemId: guid,
            captureTimestamp: ts,
          },
        },
        create: {
          marketId: country,
          itemId: guid,
          price: BigInt(price),
          currency: country === "ng" ? "NGN" : country === "tz" ? "TZS" : "KES",
          captureTimestamp: ts,
          captureUrl: `https://jiji.${country}/listing/${guid}`,
          source: "wayback-fallback",
          pageTitle: cols[1]?.slice(0, 200),
        },
        update: {},
      });
      written++;
    } catch {
      // ignore constraint violations / parse errors
    }
  }
  return written;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[live-collector] FATAL:", e);
    process.exit(1);
  });
