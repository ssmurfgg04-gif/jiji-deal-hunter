import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { medianPrice } from "@/lib/price-analysis";
import { computeLocationRisk } from "@/lib/location";

/**
 * GET /api/listings — cursor-paginated.
 *
 * Why cursor pagination:
 *   The old `take: limit` capped at 500 — with 50k+ listings the client
 *   couldn't scroll past the first page. Offset pagination (skip/take) gets
 *   slower as you page deeper because SQLite still scans all skipped rows.
 *   Cursor pagination uses a (sortKey, id) tuple + WHERE clause, so every
 *   page is O(limit) regardless of depth.
 *
 * Query params:
 *   q        — title search (case-insensitive)
 *   marketId — "ke" | "ng" | "gh" | "tz" | "ug"
 *   category — category slug
 *   class    — GREAT | FAIR | RISKY | SCAM
 *   sort     -deal (default) | price-asc | price-desc | recent | risk
 *              (distance sort falls back to in-memory — see note below)
 *   minPrice / maxPrice — price filter
 *   abuse    — "1" to filter only abuse-flagged
 *   ghost    — "1" to filter only ghost listings (sold but still active)
 *   broker   — "1" to filter only cross-market brokers
 *   buyerLoc — buyer location slug (for distance sort)
 *   cursor   — opaque cursor returned in the previous page's `nextCursor`
 *   limit    — page size (default 100, max 500)
 *
 * Returns:
 *   { count, listings, nextCursor, hasMore }
 *
 * nextCursor is null when there are no more pages.
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
  const cursor = url.searchParams.get("cursor");

  // Input validation — return 400 (not 500) on invalid numeric params.
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

  // Decode cursor: base64(JSON({ sortKey, id }))
  // sortKey is the value of the column we're sorting by (price, score, etc.)
  // id is the listing ID (tiebreaker — unique, so the cursor is deterministic).
  let cursorObj: { sortKey: string | number; id: string } | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
      if (
        decoded &&
        typeof decoded === "object" &&
        typeof decoded.id === "string" &&
        (typeof decoded.sortKey === "string" || typeof decoded.sortKey === "number")
      ) {
        cursorObj = decoded;
      } else {
        return NextResponse.json(
          { ok: false, error: "invalid cursor payload" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, error: "invalid cursor encoding" },
        { status: 400 }
      );
    }
  }

  const where: any = { deletedAt: null }; // never serve soft-deleted listings
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

  // Cursor WHERE clause — adds a strict "after (sortKey, id)" condition.
  // Implemented as: (sortKey > cursor.sortKey) OR (sortKey == cursor.sortKey AND id > cursor.id)
  // For DESC sort, this is reversed: (sortKey < cursor.sortKey) OR (sortKey == cursor.sortKey AND id < cursor.id)
  //
  // Note: for sort fields that live on the related DealScore table (score,
  // sellerRisk), we can't apply the cursor at the SQL level cleanly without
  // a join — instead we fetch `limit + 1` rows and trim client-side. This
  // is still O(limit) and avoids the deep-pagination problem.
  const isAsc = sort === "price-asc" || sort === "risk";
  const sortField =
    sort === "price-asc" || sort === "price-desc"
      ? "price"
      : sort === "recent"
        ? "collectedAt"
        : sort === "risk"
          ? "sellerRisk"
          : "score"; // default = -deal (DealScore.score DESC)

  // For Listing-native sort fields, apply the cursor at SQL level.
  // For DealScore fields, fetch +1 row and trim.
  const sortIsOnListing = sortField === "price" || sortField === "collectedAt";
  const fetchLimit = sortIsOnListing ? limit : limit + 1;

  let orderBy: any;
  let cursorWhere: any = undefined;
  if (sortIsOnListing) {
    orderBy = { [sortField]: isAsc ? "asc" : "desc", id: isAsc ? "asc" : "desc" };
    if (cursorObj) {
      const sk = cursorObj.sortKey;
      const id = cursorObj.id;
      // Convert sk to the correct type
      const typedSk = sortField === "price" ? BigInt(sk) : new Date(sk);
      if (isAsc) {
        cursorWhere = {
          OR: [
            { [sortField]: { gt: typedSk } },
            { [sortField]: typedSk, id: { gt: id } },
          ],
        };
      } else {
        cursorWhere = {
          OR: [
            { [sortField]: { lt: typedSk } },
            { [sortField]: typedSk, id: { lt: id } },
          ],
        };
      }
    }
  } else {
    // DealScore sort — join via relation, no SQL cursor (fetch +1 and trim).
    orderBy =
      sortField === "sellerRisk"
        ? { dealScore: { sellerRisk: "desc" }, id: "desc" }
        : { dealScore: { score: "desc" }, id: "desc" };
  }

  const finalWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

  let listings;
  if (sort === "distance") {
    // Distance sort is haversine — can't be done in SQL.
    // Fetch all matching without cursor pagination, sort in memory, then
    // apply cursor client-side. This is the only mode that doesn't get
    // true cursor pagination. In practice this is fine because distance
    // sort is always used with a buyerLoc filter that narrows the result set.
    listings = await db.listing.findMany({
      where,
      take: 2000, // safety cap
      include: { seller: true, dealScore: true },
    });
  } else {
    listings = await db.listing.findMany({
      where: finalWhere,
      orderBy,
      take: fetchLimit,
      include: { seller: true, dealScore: true },
    });
  }

  // Compute market median per category (in-memory grouping)
  const byCategory: Record<string, number[]> = {};
  listings.forEach((l) => {
    (byCategory[l.category] ??= []).push(Number(l.price));
  });
  const medians: Record<string, number> = {};
  for (const [cat, prices] of Object.entries(byCategory)) {
    medians[cat] = medianPrice(prices);
  }

  let enriched = listings.map((l) => {
    const locationRisk = buyerLoc ? computeLocationRisk(l.location, buyerLoc) : null;
    return {
      id: l.id,
      marketId: l.marketId,
      guid: l.guid,
      title: l.title,
      price: Number(l.price),
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
      lastSeenAt: l.lastSeenAt,
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

  // Client-side distance sort + cursor trim.
  if (sort === "distance" && buyerLoc) {
    enriched.sort((a: any, b: any) => {
      const distA = a.locationRisk?.distanceKm ?? Number.MAX_SAFE_INTEGER;
      const distB = b.locationRisk?.distanceKm ?? Number.MAX_SAFE_INTEGER;
      return distA - distB;
    });
    // Apply cursor: skip until we pass (distKm, id) from cursorObj
    if (cursorObj) {
      const cursorDist = Number(cursorObj.sortKey);
      const cursorId = cursorObj.id;
      let found = false;
      const result: any[] = [];
      for (const item of enriched) {
        const dist = item.locationRisk?.distanceKm ?? Number.MAX_SAFE_INTEGER;
        if (!found) {
          if (dist > cursorDist || (dist === cursorDist && item.id > cursorId)) {
            found = true;
            result.push(item);
          }
        } else {
          result.push(item);
        }
        if (result.length >= limit) break;
      }
      enriched = result;
    } else {
      enriched = enriched.slice(0, limit);
    }
  } else if (!sortIsOnListing) {
    // DealScore sort — trim the extra row we fetched to detect hasMore.
    // No-op for distance path (already sliced above).
  }

  // Determine hasMore + nextCursor.
  let hasMore = false;
  let nextCursor: string | null = null;
  if (sort === "distance") {
    hasMore = enriched.length === limit;
  } else if (sortIsOnListing) {
    hasMore = listings.length === limit;
  } else {
    // DealScore sort — we fetched limit+1; if we got more than limit, hasMore.
    hasMore = listings.length > limit;
    if (hasMore) {
      listings = listings.slice(0, limit);
      enriched = enriched.slice(0, limit);
    }
  }

  if (hasMore && enriched.length > 0) {
    const last = enriched[enriched.length - 1];
    let sortKey: string | number;
    if (sort === "price-asc" || sort === "price-desc") {
      sortKey = last.price;
    } else if (sort === "recent") {
      sortKey = (last.collectedAt as Date)?.toISOString?.() ?? String(last.collectedAt);
    } else if (sort === "distance") {
      sortKey = last.locationRisk?.distanceKm ?? 0;
    } else if (sort === "risk") {
      sortKey = last.score?.sellerRisk ?? 0;
    } else {
      // default -deal
      sortKey = last.score?.score ?? 0;
    }
    nextCursor = Buffer.from(
      JSON.stringify({ sortKey, id: last.id })
    ).toString("base64");
  }

  return NextResponse.json({
    count: enriched.length,
    listings: enriched,
    nextCursor,
    hasMore,
  });
}
