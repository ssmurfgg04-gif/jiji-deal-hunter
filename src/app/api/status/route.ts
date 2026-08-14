import { NextResponse } from "next/server";
import { liveApiStatus } from "@/lib/jiji-client";
import { db } from "@/lib/db";

/**
 * GET /api/status
 *
 * Returns the live API status (whether we're hitting real Jiji endpoints
 * or falling back to sample data), proxy pool health, and scheduler status.
 * Used by the dashboard header to surface a "LIVE / SAMPLE" badge.
 */
export async function GET() {
  const proxyWorking = await db.proxyPool.count({ where: { isWorking: true } });
  const proxyTotal = await db.proxyPool.count();

  return NextResponse.json({
    liveApi: liveApiStatus,
    proxyPool: {
      working: proxyWorking,
      total: proxyTotal,
    },
  });
}
