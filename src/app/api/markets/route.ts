import { NextResponse } from "next/server";
import { MARKETS } from "@/lib/jiji-client";
import { db } from "@/lib/db";

/**
 * GET /api/markets
 *
 * Returns all configured Jiji markets with their census metadata.
 */
export async function GET() {
  const dbMarkets = await db.market.findMany();
  const byId = new Map(dbMarkets.map((m) => [m.id, m]));

  const markets = MARKETS.map((m) => {
    const dbEntry = byId.get(m.id);
    return {
      id: m.id,
      name: m.name,
      baseUrl: m.baseUrl,
      currency: m.currency,
      enabled: dbEntry?.enabled ?? true,
      lastCensusAt: dbEntry?.lastCensusAt ?? null,
    };
  });

  return NextResponse.json({ ok: true, count: markets.length, markets });
}
