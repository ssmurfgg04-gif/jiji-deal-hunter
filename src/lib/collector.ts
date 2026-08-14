/**
 * Collection Pipeline — LIVE ONLY
 *
 * Flow:
 *   1. (Optional) Run market census → update Category table with live counts
 *   2. For each enabled market × top categories:
 *      a. Fetch category feed (ads_per_page=100, follow next_url)
 *      b. For each listing: upsert seller, upsert listing, index image hashes
 *      c. Compute market median, score the deal, store DealScore
 *   3. Record CollectionRun with stats and log
 *
 * No synthetic fallback — if live API is blocked, returns failure summary
 * and the dashboard shows the "BLOCKED" status badge.
 */

import { db } from "./db";
import {
  jiji,
  ensureMarket,
  persistCensus,
  type JijiListing,
  type JijiSeller,
  type MarketId,
  MARKETS,
} from "./jiji-client";
import { scoreDeal } from "./deal-scorer";
import { medianPrice } from "./price-analysis";
import { indexListingImages, getListingDuplicateSignals } from "./image-hash";

// Default: top categories to scrape per market when none specified.
// Cat IDs are Jiji's numeric IDs (3 = cars in KE etc.) — the actual mapping
// is discovered via the market census, but these are sane defaults.
const DEFAULT_TOP_CATEGORIES: Record<MarketId, Array<{ catId: number; slug: string }>> = {
  ke: [
    { catId: 3, slug: "vehicles" },
    { catId: 49, slug: "phones-tablets" },
    { catId: 89, slug: "electronics" },
    { catId: 105, slug: "computers-laptops" },
  ],
  ng: [
    { catId: 3, slug: "vehicles" },
    { catId: 49, slug: "phones-tablets" },
  ],
  gh: [{ catId: 3, slug: "vehicles" }],
  tz: [{ catId: 3, slug: "vehicles" }],
  ug: [{ catId: 3, slug: "vehicles" }],
};

export interface CollectionSummary {
  runId: string;
  marketId: string | null;
  itemsCollected: number;
  itemsUpdated: number;
  fakeDiscounts: number;
  scamsFlagged: number;
  durationMs: number;
  sourceMode: "api";
  log: string[];
  blocked: boolean; // true if Cloudflare blocked all calls
}

async function upsertSeller(seller: JijiSeller): Promise<boolean> {
  const phoneLeaked = seller.hide_phone && !!seller.phone;
  const isDealer = seller.adverts_count > 0 && seller.adverts_count / Math.max(seller.feedback_count, 1) > 50;
  await db.seller.upsert({
    where: { id: seller.id },
    create: {
      id: seller.id,
      marketId: seller.marketId,
      numericUserId: seller.numericUserId,
      username: seller.username,
      location: seller.location,
      accountAgeDays: seller.account_age_days,
      totalListings: seller.total_items,
      advertsCount: seller.adverts_count,
      feedbackCount: seller.feedback_count,
      rating: seller.rating,
      hidePhone: seller.hide_phone,
      phoneLeaked,
      phone: seller.phone,
      verifiedBadge: seller.verified_badge,
      isDealer,
    },
    update: {
      username: seller.username,
      location: seller.location,
      accountAgeDays: seller.account_age_days,
      totalListings: seller.total_items,
      advertsCount: seller.adverts_count,
      feedbackCount: seller.feedback_count,
      rating: seller.rating,
      hidePhone: seller.hide_phone,
      phoneLeaked,
      phone: seller.phone,
      verifiedBadge: seller.verified_badge,
      isDealer,
    },
  });
  return phoneLeaked;
}

async function upsertListing(item: JijiListing): Promise<{ isNew: boolean; marketMedian: number }> {
  const sameCategory = await db.listing.findMany({
    where: { category: item.category, marketId: item.marketId },
    select: { price: true },
  });
  const marketPrices = sameCategory.map((l) => l.price);
  if (marketPrices.length === 0) marketPrices.push(item.price);
  const marketMedian = medianPrice(marketPrices);

  const existing = await db.listing.findUnique({ where: { id: item.id } });
  const isNew = !existing;

  await db.listing.upsert({
    where: { id: item.id },
    create: {
      id: item.id,
      marketId: item.marketId,
      guid: item.guid,
      title: item.title,
      price: item.price,
      currency: item.currency,
      category: item.category,
      categoryId: item.category_id,
      condition: item.condition,
      location: item.location,
      imageUrl: item.images[0]?.url ?? null,
      imageCount: item.images.length,
      views: item.views,
      favCount: item.fav_count,
      daysOnMarket: item.days_on_market,
      url: item.url,
      status: item.status,
      statusColor: item.status_color,
      dateCreated: item.date_created ? new Date(item.date_created) : null,
      dateEdited: item.date_edited ? new Date(item.date_edited) : null,
      dateModerated: item.date_moderated ? new Date(item.date_moderated) : null,
      soldReported: item.sold_reported,
      canMakeOffer: item.can_make_an_offer,
      abuseReported: item.abuse_reported,
      isBoost: item.is_boost,
      paidInfo: item.paid_info ? JSON.stringify(item.paid_info) : null,
      availableTopsCount: item.available_tops_count,
      sellerId: item.seller.id,
      priceHistory: {
        create: item.price_history.map((p) => ({
          price: p.price,
          recordedAt: new Date(p.recorded_at),
        })),
      },
    },
    update: {
      title: item.title,
      price: item.price,
      currency: item.currency,
      condition: item.condition,
      location: item.location,
      imageUrl: item.images[0]?.url ?? null,
      imageCount: item.images.length,
      views: item.views,
      favCount: item.fav_count,
      daysOnMarket: item.days_on_market,
      url: item.url,
      status: item.status,
      statusColor: item.status_color,
      dateCreated: item.date_created ? new Date(item.date_created) : null,
      dateEdited: item.date_edited ? new Date(item.date_edited) : null,
      dateModerated: item.date_moderated ? new Date(item.date_moderated) : null,
      soldReported: item.sold_reported,
      canMakeOffer: item.can_make_an_offer,
      abuseReported: item.abuse_reported,
      isBoost: item.is_boost,
      paidInfo: item.paid_info ? JSON.stringify(item.paid_info) : null,
      availableTopsCount: item.available_tops_count,
      sellerId: item.seller.id,
    },
  });

  if (existing) {
    const latestHistory = await db.priceHistory.findFirst({
      where: { listingId: item.id },
      orderBy: { recordedAt: "desc" },
    });
    const expectedLatest = item.price_history[item.price_history.length - 1]?.price;
    if (latestHistory?.price !== expectedLatest && expectedLatest != null) {
      await db.priceHistory.create({
        data: { listingId: item.id, price: expectedLatest, recordedAt: new Date() },
      });
    }
  }

  return { isNew, marketMedian };
}

async function scoreAndStore(
  item: JijiListing,
  marketMedian: number,
  phoneLeaked: boolean
) {
  // Index images FIRST so we can use the duplicate signals as features
  if (item.images.length > 0) {
    await indexListingImages({
      marketId: item.marketId,
      listingId: item.id,
      sellerId: item.seller.id,
      imageUrls: item.images.map((i) => i.url),
    });
  }

  const dupSignals = await getListingDuplicateSignals(item.id);

  const result = scoreDeal({
    price: item.price,
    marketMedian,
    sellerListingCount: item.seller.total_items,
    sellerAccountAgeDays: item.seller.account_age_days,
    photoCount: item.images.length,
    views: item.views,
    daysOnMarket: item.days_on_market,
    hasPhoneLeak: phoneLeaked,
    hasVerifiedBadge: item.seller.verified_badge,
    priceHistory: item.price_history.map((p) => ({
      price: p.price,
      recorded_at: p.recorded_at,
    })),
    dateCreated: item.date_created,
    dateEdited: item.date_edited,
    dateModerated: item.date_moderated,
    soldReported: item.sold_reported,
    status: item.status,
    canMakeOffer: item.can_make_an_offer,
    abuseReported: item.abuse_reported,
    isBoost: item.is_boost,
    availableTopsCount: item.available_tops_count,
    advertsCount: item.seller.adverts_count,
    feedbackCount: item.seller.feedback_count,
    imageDuplicateCount: dupSignals.imageDuplicateCount,
    crossSellerCount: dupSignals.crossSellerCount,
    relistCount: dupSignals.relistCount,
    crossMarketCount: dupSignals.crossMarketCount,
  });

  await db.dealScore.upsert({
    where: { listingId: item.id },
    create: {
      listingId: item.id,
      score: result.score,
      classification: result.classification,
      priceVsMedian: result.priceVsMedian,
      sellerRisk: result.sellerRisk,
      popularityRisk: result.popularityRisk,
      priceManipulation: result.priceManipulation,
      hasPhoneLeak: result.hasPhoneLeak,
      hasFakeDiscount: result.hasFakeDiscount,
      claimedDiscount: result.claimedDiscount,
      realDiscount: result.realDiscount,
      editChurn24h: result.editChurn24h,
      moderationChurn24h: result.moderationChurn24h,
      isGhostListing: result.isGhostListing,
      abuseFlagged: result.abuseFlagged,
      isBoosted: result.isBoosted,
      dealerRatio: result.dealerRatio,
      crossMarketBroker: result.crossMarketBroker,
      imageDuplicateCount: result.imageDuplicateCount,
      relistCount: result.relistCount,
      factors: JSON.stringify(result.factors),
    },
    update: {
      score: result.score,
      classification: result.classification,
      priceVsMedian: result.priceVsMedian,
      sellerRisk: result.sellerRisk,
      popularityRisk: result.popularityRisk,
      priceManipulation: result.priceManipulation,
      hasPhoneLeak: result.hasPhoneLeak,
      hasFakeDiscount: result.hasFakeDiscount,
      claimedDiscount: result.claimedDiscount,
      realDiscount: result.realDiscount,
      editChurn24h: result.editChurn24h,
      moderationChurn24h: result.moderationChurn24h,
      isGhostListing: result.isGhostListing,
      abuseFlagged: result.abuseFlagged,
      isBoosted: result.isBoosted,
      dealerRatio: result.dealerRatio,
      crossMarketBroker: result.crossMarketBroker,
      imageDuplicateCount: result.imageDuplicateCount,
      relistCount: result.relistCount,
      factors: JSON.stringify(result.factors),
    },
  });

  return result;
}

export interface CollectionOptions {
  marketId?: MarketId; // null = all enabled markets
  queries?: string[]; // search-based collection (uses /search endpoint)
  categories?: Array<{ catId: number; slug: string }>; // category-based (default)
  maxPagesPerCategory?: number; // default 1 (100 items per page)
  runCensus?: boolean; // refresh market census first
}

export async function runCollection(opts: CollectionOptions = {}): Promise<CollectionSummary> {
  const log: string[] = [];
  const startedAt = Date.now();

  const marketIds: MarketId[] = opts.marketId ? [opts.marketId] : (MARKETS.map((m) => m.id) as MarketId[]);

  const run = await db.collectionRun.create({
    data: {
      marketId: opts.marketId ?? null,
      sourceMode: "api",
      status: "running",
    },
  });
  log.push(`Collection run ${run.id} started (markets: ${marketIds.join(", ")})`);

  let itemsCollected = 0;
  let itemsUpdated = 0;
  let fakeDiscounts = 0;
  let scamsFlagged = 0;
  let blockedCount = 0;
  let totalApiCalls = 0;

  try {
    for (const marketId of marketIds) {
      await ensureMarket(marketId);
      log.push(`[${marketId}] Starting collection`);

      // Step 1: market census (optional but recommended)
      if (opts.runCensus !== false) {
        log.push(`[${marketId}] Fetching market census...`);
        const census = await jiji.getMarketCensus(marketId);
        if (census) {
          const persisted = await persistCensus(marketId, census);
          log.push(`[${marketId}] Census: ${persisted} categories persisted`);
          await db.market.update({
            where: { id: marketId },
            data: { lastCensusAt: new Date() },
          });
        } else {
          blockedCount++;
          log.push(`[${marketId}] Census BLOCKED (Cloudflare or network)`);
        }
      }

      // Step 2: query-based collection
      if (opts.queries && opts.queries.length > 0) {
        for (const q of opts.queries) {
          log.push(`[${marketId}] Searching: "${q}"`);
          const result = await jiji.search(marketId, { q });
          totalApiCalls++;
          if (!result) {
            blockedCount++;
            log.push(`[${marketId}] Search BLOCKED for "${q}"`);
            continue;
          }
          for (const item of result.items) {
            try {
              await upsertSeller(item.seller);
              const phoneLeaked = item.seller.hide_phone && !!item.seller.phone;
              const { isNew, marketMedian } = await upsertListing(item);
              if (isNew) itemsCollected++;
              else itemsUpdated++;
              const score = await scoreAndStore(item, marketMedian, phoneLeaked);
              if (score.hasFakeDiscount) fakeDiscounts++;
              if (score.classification === "SCAM") scamsFlagged++;
            } catch (e: any) {
              log.push(`  ! Failed to upsert ${item.id}: ${e?.message ?? "unknown"}`);
            }
          }
          log.push(`[${marketId}] "${q}": ${result.items.length} items`);
        }
      } else {
        // Step 2 alt: category-based collection
        const cats = opts.categories ?? DEFAULT_TOP_CATEGORIES[marketId] ?? [];
        const maxPages = opts.maxPagesPerCategory ?? 1;
        for (const cat of cats) {
          log.push(`[${marketId}] Category ${cat.catId}-${cat.slug} (max ${maxPages} page(s))`);
          const result = await jiji.getCategoryFeed(marketId, cat.catId, cat.slug, { maxPages });
          totalApiCalls++;
          if (!result) {
            blockedCount++;
            log.push(`[${marketId}] Category ${cat.slug} BLOCKED`);
            continue;
          }
          for (const item of result.items) {
            try {
              await upsertSeller(item.seller);
              const phoneLeaked = item.seller.hide_phone && !!item.seller.phone;
              const { isNew, marketMedian } = await upsertListing(item);
              if (isNew) itemsCollected++;
              else itemsUpdated++;
              const score = await scoreAndStore(item, marketMedian, phoneLeaked);
              if (score.hasFakeDiscount) fakeDiscounts++;
              if (score.classification === "SCAM") scamsFlagged++;
            } catch (e: any) {
              log.push(`  ! Failed to upsert ${item.id}: ${e?.message ?? "unknown"}`);
            }
          }
          log.push(`[${marketId}] Category ${cat.slug}: ${result.items.length} items`);
        }
      }
    }

    const blocked = blockedCount > 0 && totalApiCalls === blockedCount;
    await db.collectionRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        itemsCollected,
        itemsUpdated,
        fakeDiscounts,
        scamsFlagged,
        log: log.join("\n"),
      },
    });
    log.push(
      `Collection completed: ${itemsCollected} new, ${itemsUpdated} updated, ${fakeDiscounts} fake discounts, ${scamsFlagged} scams, ${blockedCount}/${totalApiCalls} calls blocked`
    );

    return {
      runId: run.id,
      marketId: opts.marketId ?? null,
      itemsCollected,
      itemsUpdated,
      fakeDiscounts,
      scamsFlagged,
      durationMs: Date.now() - startedAt,
      sourceMode: "api",
      log,
      blocked,
    };
  } catch (e: any) {
    log.push(`FATAL: ${e?.message ?? "unknown"}`);
    await db.collectionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), log: log.join("\n") },
    });
    throw e;
  }
}

export async function isDatabaseEmpty(): Promise<boolean> {
  const count = await db.listing.count();
  return count === 0;
}

export async function getLastRun() {
  return db.collectionRun.findFirst({
    where: { status: "completed" },
    orderBy: { finishedAt: "desc" },
  });
}
