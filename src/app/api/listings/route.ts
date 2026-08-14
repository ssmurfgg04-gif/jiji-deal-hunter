import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { medianPrice } from "@/lib/price-analysis";
import { computeLocationRisk } from "@/lib/location";

/**
 * GET /api/listings
 *
 * Query params:
 *   q        — title search (case-insensitive)
 *   marketId — "ke" | "ng" | "gh" | "tz" | "ug"
 *   category — category slug
 *   class    — GREAT | FAIR | RISKY | SCAM
 *   sort     -deal (default) | price-asc | price-desc | recent | risk | distance
 *   minPrice / maxPrice — price filter
 *   abuse    — "1" to filter only abuse-flagged
 *   ghost    — "1" to filter only ghost listings (sold but still active)
 *   broker   — "1" to filter only cross-market brokers
 *   buyerLoc — buyer location slug (e.g. "nairobi") for distance-based sort/filter
 *
 * Returns listings enriched with seller + dealScore + market median + location risk.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const marketId = url.searchParams.get("marketId");
  const category = url.searchParams.get("category")?.trim() ?? "";
  const classification = url.searchParams.get("class")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "-deal";
  const minPriceRaw = url.searchParams.get("minPrice");
  const maxPriceRaw = url.searchParams.get("maxPrice");
  const abuseOnly = url.searchParams.get("abuse") === "1";
  const ghostOnly = url.searchParams.get("ghost") === "1";
  const brokerOnly = url.searchParams.get("broker") === "1";
  const buyerLoc = url.searchParams.get("buyerLoc") ?? null;

  // Input validation — return 400 (not 500) on invalid numeric params.
  // Prevents Prisma internals from leaking in error messages.
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isNaN(limitRaw) ? 100 : Math.max(1, Math.min(limitRaw, 500));

  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  if (minPriceRaw != null) {
    minPrice = parseInt(minPriceRaw, 10);
    if (Number.isNaN(minPrice)) {
      return NextResponse.json(
        { ok: false, error: "minPrice must be an integer" },
        { status: 400 }
      );
    }
  }
  if (maxPriceRaw != null) {
    maxPrice = parseInt(maxPriceRaw, 10);
    if (Number.isNaN(maxPrice)) {
      return NextResponse.json(
        { ok: false, error: "maxPrice must be an integer" },
        { status: 400 }
      );
    }
  }

  const where: any = {};
  if (q) where.title = { contains: q };
  if (marketId) where.marketId = marketId;
  if (category) where.category = category;
  if (classification) where.dealScore = { classification };
  if (minPrice != null || maxPrice != null) {
    where.price = {};
    if (minPrice != null) where.price.gte = minPrice;
    if (maxPrice != null) where.price.lte = maxPrice;
  }
  if (abuseOnly) where.abuseReported = true;
  if (ghostOnly) {
    where.soldReported = true;
    where.status = "active";
  }
  if (brokerOnly) where.dealScore = { crossMarketBroker: true };

  // For distance sort we fetch all matching then sort client-side (no DB index for haversine)
  const orderBy: any =
    sort === "price-asc"
      ? { price: "asc" }
      : sort === "price-desc"
        ? { price: "desc" }
        : sort === "recent"
          ? { collectedAt: "desc" }
          : sort === "risk"
            ? { dealScore: { sellerRisk: "desc" } }
            : sort === "distance"
              ? undefined // client-side sort below
              : { dealScore: { score: "desc" } };

  const listings = await db.listing.findMany({
    where,
    ...(orderBy ? { orderBy } : {}),
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

  // Compute location risk per listing (if buyer location provided)
  let enriched = listings.map((l) => {
    const locationRisk = buyerLoc
      ? computeLocationRisk(l.location, buyerLoc)
      : null;
    return {
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
      locationRisk,
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
    };
  });

  // Client-side distance sort (haversine can't be done in SQL)
  if (sort === "distance" && buyerLoc) {
    enriched.sort((a: any, b: any) => {
      const distA = a.locationRisk?.distanceKm ?? Number.MAX_SAFE_INTEGER;
      const distB = b.locationRisk?.distanceKm ?? Number.MAX_SAFE_INTEGER;
      return distA - distB;
    });
  }

  return NextResponse.json({ count: enriched.length, listings: enriched });
}
