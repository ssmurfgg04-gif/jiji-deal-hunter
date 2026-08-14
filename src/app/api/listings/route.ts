import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { medianPrice } from "@/lib/price-analysis";

/**
 * GET /api/listings
 *
 * Query params:
 *   q        — title search (case-insensitive)
 *   marketId — "ke" | "ng" | "gh" | "tz" | "ug"
 *   category — category slug
 *   class    — GREAT | FAIR | RISKY | SCAM
 *   sort     -deal (default) | price-asc | price-desc | recent | risk
 *   minPrice / maxPrice — price filter
 *   abuse    — "1" to filter only abuse-flagged
 *   ghost    — "1" to filter only ghost listings (sold but still active)
 *   broker   — "1" to filter only cross-market brokers
 *
 * Returns listings enriched with seller + dealScore + market median.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const marketId = url.searchParams.get("marketId");
  const category = url.searchParams.get("category")?.trim() ?? "";
  const classification = url.searchParams.get("class")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "-deal";
  const minPrice = url.searchParams.get("minPrice");
  const maxPrice = url.searchParams.get("maxPrice");
  const abuseOnly = url.searchParams.get("abuse") === "1";
  const ghostOnly = url.searchParams.get("ghost") === "1";
  const brokerOnly = url.searchParams.get("broker") === "1";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);

  const where: any = {};
  if (q) where.title = { contains: q };
  if (marketId) where.marketId = marketId;
  if (category) where.category = category;
  if (classification) where.dealScore = { classification };
  if (minPrice || maxPrice) {
    where.price = {};
    if (minPrice) where.price.gte = parseInt(minPrice, 10);
    if (maxPrice) where.price.lte = parseInt(maxPrice, 10);
  }
  if (abuseOnly) where.abuseReported = true;
  if (ghostOnly) {
    where.soldReported = true;
    where.status = "active";
  }
  if (brokerOnly) where.dealScore = { crossMarketBroker: true };

  const orderBy: any =
    sort === "price-asc"
      ? { price: "asc" }
      : sort === "price-desc"
        ? { price: "desc" }
        : sort === "recent"
          ? { collectedAt: "desc" }
          : sort === "risk"
            ? { dealScore: { sellerRisk: "desc" } }
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
    marketId: l.marketId,
    guid: l.guid,
    title: l.title,
    price: l.price,
    currency: l.currency,
    category: l.category,
    categoryId: l.categoryId,
    condition: l.condition,
    location: l.location,
    imageUrl: l.imageUrl,
    imageCount: l.imageCount,
    views: l.views,
    favCount: l.favCount,
    daysOnMarket: l.daysOnMarket,
    url: l.url,
    collectedAt: l.collectedAt,
    // Recon-derived fields
    status: l.status,
    statusColor: l.statusColor,
    dateCreated: l.dateCreated,
    dateEdited: l.dateEdited,
    dateModerated: l.dateModerated,
    soldReported: l.soldReported,
    canMakeOffer: l.canMakeOffer,
    abuseReported: l.abuseReported,
    isBoost: l.isBoost,
    availableTopsCount: l.availableTopsCount,
    seller: {
      id: l.seller.id,
      marketId: l.seller.marketId,
      numericUserId: l.seller.numericUserId,
      username: l.seller.username,
      location: l.seller.location,
      accountAgeDays: l.seller.accountAgeDays,
      totalListings: l.seller.totalListings,
      advertsCount: l.seller.advertsCount,
      feedbackCount: l.seller.feedbackCount,
      rating: l.seller.rating,
      hidePhone: l.seller.hidePhone,
      phoneLeaked: l.seller.phoneLeaked,
      phone: l.seller.phone,
      verifiedBadge: l.seller.verifiedBadge,
      isDealer: l.seller.isDealer,
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
          editChurn24h: l.dealScore.editChurn24h,
          moderationChurn24h: l.dealScore.moderationChurn24h,
          isGhostListing: l.dealScore.isGhostListing,
          abuseFlagged: l.dealScore.abuseFlagged,
          isBoosted: l.dealScore.isBoosted,
          dealerRatio: l.dealScore.dealerRatio,
          crossMarketBroker: l.dealScore.crossMarketBroker,
          imageDuplicateCount: l.dealScore.imageDuplicateCount,
          relistCount: l.dealScore.relistCount,
        }
      : null,
  }));

  return NextResponse.json({ count: enriched.length, listings: enriched });
}
