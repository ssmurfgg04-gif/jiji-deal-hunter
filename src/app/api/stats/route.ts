import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLastRun } from "@/lib/collector";

/**
 * GET /api/stats
 *
 * Dashboard header stats — now includes recon-derived scam signals.
 */
export async function GET() {
  const total = await db.listing.count();
  const greatDeals = await db.dealScore.count({ where: { classification: "GREAT" } });
  const fairDeals = await db.dealScore.count({ where: { classification: "FAIR" } });
  const riskyDeals = await db.dealScore.count({ where: { classification: "RISKY" } });
  const scams = await db.dealScore.count({ where: { classification: "SCAM" } });
  const fakeDiscounts = await db.dealScore.count({ where: { hasFakeDiscount: true } });

  // Recon-derived signals
  const ghostListings = await db.dealScore.count({ where: { isGhostListing: true } });
  const abuseFlagged = await db.dealScore.count({ where: { abuseFlagged: true } });
  const editChurn = await db.dealScore.count({ where: { editChurn24h: true } });
  const moderationChurn = await db.dealScore.count({ where: { moderationChurn24h: true } });
  const crossMarketBrokers = await db.dealScore.count({ where: { crossMarketBroker: true } });
  const dealers = await db.seller.count({ where: { isDealer: true } });

  // Image-hash stats
  const totalHashes = await db.imageHash.count();
  // Get all distinct hashes, then filter to duplicates client-side
  // (Prisma groupBy having-clause is finicky across versions.)
  const allHashes = await db.imageHash.findMany({
    select: { hash: true, listingId: true },
    distinct: ["hash", "listingId"],
  });
  const hashCounts = new Map<string, number>();
  for (const h of allHashes) {
    hashCounts.set(h.hash, (hashCounts.get(h.hash) ?? 0) + 1);
  }
  const dupHashCount = Array.from(hashCounts.values()).filter((c) => c > 1).length;

  const discountRows = await db.dealScore.findMany({
    where: { realDiscount: { gt: 0 } },
    select: { realDiscount: true },
  });
  const avgDiscount =
    discountRows.length > 0
      ? discountRows.reduce((a, b) => a + (b.realDiscount ?? 0), 0) / discountRows.length
      : 0;

  const byCategory = await db.listing.groupBy({
    by: ["category"],
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });

  const byMarket = await db.listing.groupBy({
    by: ["marketId"],
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
    // Recon-derived
    ghostListings,
    abuseFlagged,
    editChurn,
    moderationChurn,
    crossMarketBrokers,
    dealers,
    imageHashes: {
      total: totalHashes,
      duplicates: dupHashCount,
    },
    categories: byCategory.map((c) => ({ slug: c.category, count: c._count.id })),
    markets: byMarket.map((m) => ({ id: m.marketId, count: m._count.id })),
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
