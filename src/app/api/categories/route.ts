import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jiji, MARKETS, type MarketId } from "@/lib/jiji-client";

/**
 * GET /api/categories?marketId=ke&refresh=1
 *
 * Returns the market census (category IDs + live listing counts) for a market.
 *   - Without refresh=1: returns categories from DB (cached from last census)
 *   - With refresh=1: hits live Jiji /categories_counts.json, persists, then returns
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const marketId = (url.searchParams.get("marketId") ?? "ke") as MarketId;
  const refresh = url.searchParams.get("refresh") === "1";

  if (!MARKETS.find((m) => m.id === marketId)) {
    return NextResponse.json({ ok: false, error: "invalid market" }, { status: 400 });
  }

  if (refresh) {
    const census = await jiji.getMarketCensus(marketId);
    if (!census) {
      return NextResponse.json({
        ok: false,
        blocked: true,
        error: "Live API blocked (Cloudflare) or unreachable.",
      });
    }
    // Persist
    let persisted = 0;
    for (const e of census) {
      if (e.catId === 0 || !e.slug) continue;
      await db.category.upsert({
        where: { marketId_catId: { marketId, catId: e.catId } },
        create: {
          id: `${marketId}-${e.catId}`,
          marketId,
          catId: e.catId,
          slug: e.slug,
          name: e.name,
          listingCount: e.count,
          lastSeenAt: new Date(),
        },
        update: {
          slug: e.slug,
          name: e.name,
          listingCount: e.count,
          lastSeenAt: new Date(),
        },
      });
      persisted++;
    }
    return NextResponse.json({
      ok: true,
      marketId,
      refreshed: true,
      persisted,
      categories: census.sort((a, b) => b.count - a.count),
    });
  }

  // Cached read
  const categories = await db.category.findMany({
    where: { marketId },
    orderBy: { listingCount: "desc" },
  });
  const market = await db.market.findUnique({ where: { id: marketId } });
  return NextResponse.json({
    ok: true,
    marketId,
    market,
    count: categories.length,
    categories: categories.map((c) => ({
      catId: c.catId,
      slug: c.slug,
      name: c.name,
      listingCount: c.listingCount,
      lastSeenAt: c.lastSeenAt,
    })),
  });
}
