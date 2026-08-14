import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { medianPrice } from "@/lib/price-analysis";

/**
 * GET /api/listings
 *
 * Query params:
 *   q        — title search (case-insensitive)
 *   category — category filter
 *   class    — GREAT | FAIR | RISKY | SCAM
 *   sort     -deal (default, best first) | price-asc | price-desc | recent
 *
 * Returns listings enriched with seller + dealScore + market median.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const classification = url.searchParams.get("class")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "-deal";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);

  const where: any = {};
  if (q) where.title = { contains: q };
  if (category) where.category = category;
  if (classification) where.dealScore = { classification };

  const orderBy: any =
    sort === "price-asc"
      ? { price: "asc" }
      : sort === "price-desc"
        ? { price: "desc" }
        : sort === "recent"
          ? { collectedAt: "desc" }
          : { dealScore: { score: "desc" } };

  const listings = await db.listing.findMany({
    where,
    orderBy,
    take: limit,
    include: {
      seller: true,
      dealScore: true,
    },
  });

  // Compute market median per category (in-memory grouping)
  const byCategory: Record<string, number[]> = {};
  listings.forEach((l) => {
    (byCategory[l.category] ??= []).push(l.price);
  });
  const medians: Record<string, number> = {};
  for (const [cat, prices] of Object.entries(byCategory)) {
    medians[cat] = medianPrice(prices);
  }

  const enriched = listings.map((l) => ({
    id: l.id,
    title: l.title,
    price: l.price,
    currency: l.currency,
    category: l.category,
    condition: l.condition,
    location: l.location,
    imageUrl: l.imageUrl,
    imageCount: l.imageCount,
    views: l.views,
    daysOnMarket: l.daysOnMarket,
    url: l.url,
    collectedAt: l.collectedAt,
    seller: {
      id: l.seller.id,
      username: l.seller.username,
      location: l.seller.location,
      accountAgeDays: l.seller.accountAgeDays,
      totalListings: l.seller.totalListings,
      rating: l.seller.rating,
      hidePhone: l.seller.hidePhone,
      phoneLeaked: l.seller.phoneLeaked,
      phone: l.seller.phone,
      verifiedBadge: l.seller.verifiedBadge,
    },
    marketMedian: medians[l.category],
    score: l.dealScore
      ? {
          score: l.dealScore.score,
          classification: l.dealScore.classification,
          priceVsMedian: l.dealScore.priceVsMedian,
          sellerRisk: l.dealScore.sellerRisk,
          popularityRisk: l.dealScore.popularityRisk,
          priceManipulation: l.dealScore.priceManipulation,
          hasPhoneLeak: l.dealScore.hasPhoneLeak,
          hasFakeDiscount: l.dealScore.hasFakeDiscount,
          claimedDiscount: l.dealScore.claimedDiscount,
          realDiscount: l.dealScore.realDiscount,
        }
      : null,
  }));

  return NextResponse.json({
    count: enriched.length,
    listings: enriched,
  });
}
