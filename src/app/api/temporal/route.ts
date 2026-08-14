import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cacheAside } from "@/lib/cache";

/**
 * GET /api/temporal
 *
 * Returns canonical items with temporal data (price time series, days_listed,
 * motivated_seller / stale_listing / flip_opportunity flags).
 *
 * Query params:
 *   marketId — filter by market
 *   target   — "motivated" | "stale" | "flip" | "all" (default: all with temporal signal)
 *   limit    — max results (default 50, max 200)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const marketId = url.searchParams.get("marketId");
  const target = url.searchParams.get("target") ?? "all";
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isNaN(limitRaw) ? 50 : Math.max(1, Math.min(limitRaw, 200));

  const cacheKey = `temporal:${marketId ?? "all"}:${target}:${limit}`;

  const data = await cacheAside(cacheKey, 30, async () => {
    const where: any = { captureCount: { gte: 2 } };
    if (marketId) where.marketId = marketId;
    if (target === "motivated") where.motivatedSeller = true;
    else if (target === "stale") where.staleListing = true;
    else if (target === "flip") where.flipOpportunity = true;

    const items = await db.canonicalItem.findMany({
      where,
      orderBy: { priceDeltaPct: "asc" },
      take: limit,
    });

    return {
      count: items.length,
      items: items.map((i) => ({
        id: i.id,
        marketId: i.marketId,
        itemId: i.itemId,
        firstSeenAt: i.firstSeenAt,
        lastSeenAt: i.lastSeenAt,
        captureCount: i.captureCount,
        daysListed: i.daysListed,
        firstPrice: i.firstPrice != null ? Number(i.firstPrice) : null,
        lastPrice: i.lastPrice != null ? Number(i.lastPrice) : null,
        priceDeltaPct: i.priceDeltaPct,
        priceVolatility: i.priceVolatility,
        priceDropRate: i.priceDropRate,
        priceHistory: JSON.parse(i.priceHistory),
        motivatedSeller: i.motivatedSeller,
        staleListing: i.staleListing,
        flipOpportunity: i.flipOpportunity,
      })),
    };
  });

  return NextResponse.json(data);
}
