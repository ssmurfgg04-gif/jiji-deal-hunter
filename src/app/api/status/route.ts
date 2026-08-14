import { NextResponse } from "next/server";
import { liveApiStatus } from "@/lib/jiji-client";
import { db } from "@/lib/db";

/**
 * GET /api/status
 *
 * Returns the live API status, proxy pool health, and per-market collection state.
 */
export async function GET() {
  const proxyWorking = await db.proxyPool.count({ where: { isWorking: true } });
  const proxyTotal = await db.proxyPool.count();

  // Per-market collection state
  const markets = await db.market.findMany({
    select: {
      id: true,
      name: true,
      enabled: true,
      lastCensusAt: true,
    },
  });

  // Per-market listing counts
  const byMarket = await db.listing.groupBy({
    by: ["marketId"],
    _count: { id: true },
  });
  const marketCounts = new Map(byMarket.map((m) => [m.marketId, m._count.id]));

  return NextResponse.json({
    liveApi: liveApiStatus,
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
