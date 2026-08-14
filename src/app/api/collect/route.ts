import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runCollection } from "@/lib/collector";
import { MARKETS, type MarketId } from "@/lib/jiji-client";
import { cacheInvalidate, cacheInvalidatePrefix } from "@/lib/cache";

/**
 * POST /api/collect
 *
 * Body options:
 *   marketId?: "ke" | "ng" | "gh" | "tz" | "ug" (default: all enabled)
 *   queries?: string[]             — search-based collection
 *   categories?: [{catId, slug}]   — category-based collection (default)
 *   maxPagesPerCategory?: number  — default 1 (100 items per page)
 *   runCensus?: boolean            — default true
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const marketId = body?.marketId as MarketId | undefined;
    if (marketId && !MARKETS.find((m) => m.id === marketId)) {
      return NextResponse.json({ ok: false, error: "invalid market" }, { status: 400 });
    }
    const summary = await runCollection({
      marketId,
      queries: body?.queries,
      categories: body?.categories,
      maxPagesPerCategory: body?.maxPagesPerCategory,
      runCensus: body?.runCensus,
    });

    // Invalidate caches after a successful run so the dashboard sees fresh data
    if (!summary.blocked) {
      await cacheInvalidate("stats:v2");
      await cacheInvalidatePrefix("listings:");
    }

    const statusCode = summary.blocked ? 502 : 200;
    return NextResponse.json({ ok: !summary.blocked, summary }, { status: statusCode });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "collection failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/collect — returns the last N collection runs.
 */
export async function GET() {
  const runs = await db.collectionRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  return NextResponse.json({ runs });
}
