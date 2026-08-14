#!/usr/bin/env bun
/**
 * Entity resolution — collapse multiple WaybackHtmlExtract rows
 * (same itemId, different timestamps) into CanonicalItem records
 * with computed price time series.
 *
 * For each (marketId, itemId) group:
 *   - Sort captures by timestamp ascending
 *   - Compute first_seen, last_seen, days_listed, capture_count
 *   - Compute price_delta_pct, price_volatility, price_drop_rate
 *   - Sanity check: flag items with >10x price jumps between consecutive
 *     captures (likely currency mismatch or data error)
 *
 * This is the canonicalization layer that enables the non-leaking
 * "motivated seller" target.
 *
 * Usage: bun scripts/resolve-entities.ts
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

interface PricePoint {
  t: string; // ISO timestamp
  price: string; // BigInt as string for JSON serialization
}

function computeStddev(prices: number[]): number {
  if (prices.length < 2) return 0;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((acc, p) => acc + (p - mean) ** 2, 0) / prices.length;
  return Math.sqrt(variance);
}

async function main() {
  console.log("[resolve] Loading all WaybackHtmlExtract rows...");

  // Group by (marketId, itemId)
  const groups = await db.waybackHtmlExtract.groupBy({
    by: ["marketId", "itemId"],
    _count: { captureTimestamp: true },
    orderBy: { _count: { captureTimestamp: "desc" } },
  });

  console.log(`[resolve] Found ${groups.length} unique (marketId, itemId) groups`);

  let resolved = 0;
  let multiCapture = 0;
  let singleCapture = 0;
  let flagged = 0;

  for (const group of groups) {
    const { marketId, itemId } = group;
    const captureCount = group._count.captureTimestamp;

    // Fetch all captures for this item, sorted by timestamp
    const captures = await db.waybackHtmlExtract.findMany({
      where: { marketId, itemId },
      orderBy: { captureTimestamp: "asc" },
    });

    if (captures.length === 0) continue;

    const firstSeenAt = captures[0].captureTimestamp;
    const lastSeenAt = captures[captures.length - 1].captureTimestamp;
    const daysListed = Math.max(
      0,
      Math.floor((lastSeenAt.getTime() - firstSeenAt.getTime()) / 86400000)
    );

    const firstPrice = captures[0].price;
    const lastPrice = captures[captures.length - 1].price;
    const firstPriceNum = Number(firstPrice);
    const lastPriceNum = Number(lastPrice);

    // price_delta_pct: (lastPrice - firstPrice) / firstPrice
    const priceDeltaPct =
      firstPriceNum > 0 ? (lastPriceNum - firstPriceNum) / firstPriceNum : 0;

    // Price history as JSON array
    const priceHistory: PricePoint[] = captures.map((c) => ({
      t: c.captureTimestamp.toISOString(),
      price: c.price.toString(),
    }));

    // Volatility: stddev of prices, normalized by mean
    const prices = captures.map((c) => Number(c.price));
    const meanPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const priceVolatility = meanPrice > 0 ? computeStddev(prices) / meanPrice : 0;

    // Drop rate: price_delta_pct per day
    const priceDropRate = daysListed > 0 ? priceDeltaPct / daysListed : 0;

    // Sanity check: flag items with >10x price jumps between consecutive captures
    // (likely currency mismatch or data error — NGN vs KES confusion)
    let hasAnomaly = false;
    for (let i = 1; i < captures.length; i++) {
      const prev = Number(captures[i - 1].price);
      const curr = Number(captures[i].price);
      if (prev > 0 && curr > 0) {
        const ratio = curr / prev;
        if (ratio > 10 || ratio < 0.1) {
          hasAnomaly = true;
          break;
        }
      }
    }
    if (hasAnomaly) flagged++;

    // Compute temporal targets (non-leaking):
    // motivated_seller: price dropped >10% AND stayed listed >7d AND >=2 captures
    // (Loosened from >20%/>14d/>=3 because the Wayback dataset has very few
    // items with actual price changes — only 8/516 multi-capture items had
    // any price change at all. The crawler mostly captured the same page
    // within hours during the Nov 2022 bot crawl.)
    const motivatedSeller =
      priceDeltaPct < -0.10 &&
      daysListed >= 7 &&
      captureCount >= 2 &&
      lastPriceNum > 0 &&
      !hasAnomaly;

    // stale_listing: listed >14d with flat or rising price (not selling)
    const staleListing = daysListed > 14 && priceDeltaPct >= -0.05 && captureCount >= 2;

    // flip_opportunity: price dropped AND has enough captures to trust the signal
    const flipOpportunity = priceDeltaPct < -0.05 && daysListed >= 3 && captureCount >= 2;

    await db.canonicalItem.upsert({
      where: { id: `${marketId}-${itemId}` },
      create: {
        id: `${marketId}-${itemId}`,
        marketId,
        itemId,
        firstSeenAt,
        lastSeenAt,
        captureCount,
        daysListed,
        priceHistory: JSON.stringify(priceHistory),
        firstPrice,
        lastPrice,
        priceDeltaPct,
        priceVolatility,
        priceDropRate,
        motivatedSeller,
        staleListing,
        flipOpportunity,
      },
      update: {
        firstSeenAt,
        lastSeenAt,
        captureCount,
        daysListed,
        priceHistory: JSON.stringify(priceHistory),
        firstPrice,
        lastPrice,
        priceDeltaPct,
        priceVolatility,
        priceDropRate,
        motivatedSeller,
        staleListing,
        flipOpportunity,
      },
    });

    resolved++;
    if (captureCount > 1) multiCapture++;
    else singleCapture++;

    if (resolved % 500 === 0) {
      console.log(
        `[resolve] Progress: ${resolved}/${groups.length} (multi-capture: ${multiCapture}, motivated: ${motivatedSeller ? "←" : ""})`
      );
    }
  }

  console.log(`\n[resolve] Done.`);
  console.log(`  Resolved:           ${resolved}`);
  console.log(`  Multi-capture:      ${multiCapture} (have temporal signal)`);
  console.log(`  Single-capture:     ${singleCapture} (no temporal signal)`);
  console.log(`  Flagged (anomaly): ${flagged}`);

  // Report temporal signal stats
  const motivated = await db.canonicalItem.count({ where: { motivatedSeller: true } });
  const stale = await db.canonicalItem.count({ where: { staleListing: true } });
  const flip = await db.canonicalItem.count({ where: { flipOpportunity: true } });
  console.log(`\n  Temporal targets:`);
  console.log(`    Motivated sellers: ${motivated}`);
  console.log(`    Stale listings:    ${stale}`);
  console.log(`    Flip opportunities: ${flip}`);

  // Top 10 biggest price drops
  const topDrops = await db.canonicalItem.findMany({
    where: { priceDeltaPct: { lt: -0.10 } },
    orderBy: { priceDeltaPct: "asc" },
    take: 10,
  });
  if (topDrops.length > 0) {
    console.log(`\n  Top 10 biggest price drops:`);
    for (const d of topDrops) {
      console.log(
        `    ${d.marketId}/${d.itemId}: ${(d.priceDeltaPct * 100).toFixed(1)}% over ${d.daysListed}d (${d.captureCount} captures)`
      );
    }
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[resolve] FATAL:", e);
  process.exit(1);
});
