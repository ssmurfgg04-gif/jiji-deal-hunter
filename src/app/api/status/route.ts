import { NextResponse } from "next/server";
import { getLiveApiStatus } from "@/lib/jiji-client";
import { db } from "@/lib/db";

/**
 * GET /api/status
 *
 * Returns the live API status, proxy pool health, and per-market collection state.
 * Filters out soft-deleted listings from counts.
 */
export async function GET() {
  const [proxyWorking, proxyTotal] = await Promise.all([
    db.proxyPool.count({ where: { isWorking: true } }),
    db.proxyPool.count(),
  ]);

  // Per-market collection state
  const markets = await db.market.findMany({
    select: {
      id: true,
      name: true,
      enabled: true,
      lastCensusAt: true,
    },
  });

  // Per-market listing counts — exclude soft-deleted
  const byMarket = await db.listing.groupBy({
    by: ["marketId"],
    where: { deletedAt: null },
    _count: { id: true },
  });
  const marketCounts = new Map(byMarket.map((m) => [m.marketId, m._count.id]));

  const liveApi = await getLiveApiStatus();

  return NextResponse.json({
    liveApi,
    proxyPool: {
      working: proxyWorking,
      total: proxyTotal,
    },
    markets: markets.map((m) => ({
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      lastCensusAt: m.lastCensusAt,
      listingsTracked: marketCounts.get(m.id) ?? 0,
    })),
  });
}
