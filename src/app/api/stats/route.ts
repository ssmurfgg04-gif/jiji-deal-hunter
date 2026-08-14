import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLastRun } from "@/lib/collector";

/**
 * GET /api/stats
 *
 * Returns dashboard header stats:
 *   - total listings
 *   - great deals count
 *   - fake discounts flagged
 *   - scams flagged
 *   - avg discount among discounted listings
 *   - last collection run info
 *   - per-category breakdown
 */
export async function GET() {
  const total = await db.listing.count();
  const greatDeals = await db.dealScore.count({ where: { classification: "GREAT" } });
  const fairDeals = await db.dealScore.count({ where: { classification: "FAIR" } });
  const riskyDeals = await db.dealScore.count({ where: { classification: "RISKY" } });
  const scams = await db.dealScore.count({ where: { classification: "SCAM" } });
  const fakeDiscounts = await db.dealScore.count({ where: { hasFakeDiscount: true } });

  // Avg real discount among listings with a real discount > 0
  const discountRows = await db.dealScore.findMany({
    where: { realDiscount: { gt: 0 } },
    select: { realDiscount: true },
  });
  const avgDiscount =
    discountRows.length > 0
      ? discountRows.reduce((a, b) => a + (b.realDiscount ?? 0), 0) / discountRows.length
      : 0;

  // Category breakdown
  const byCategory = await db.listing.groupBy({
    by: ["category"],
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });

  const lastRun = await getLastRun();

  return NextResponse.json({
    total,
    greatDeals,
    fairDeals,
    riskyDeals,
    scams,
    fakeDiscounts,
    avgDiscount: Number(avgDiscount.toFixed(3)),
    categories: byCategory.map((c) => ({ slug: c.category, count: c._count.id })),
    lastRun: lastRun
      ? {
          id: lastRun.id,
          finishedAt: lastRun.finishedAt,
          startedAt: lastRun.startedAt,
          itemsCollected: lastRun.itemsCollected,
          itemsUpdated: lastRun.itemsUpdated,
          fakeDiscounts: lastRun.fakeDiscounts,
          scamsFlagged: lastRun.scamsFlagged,
          sourceMode: lastRun.sourceMode,
        }
      : null,
  });
}
