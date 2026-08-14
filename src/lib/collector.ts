/**
 * Collection Pipeline
 *
 * Orchestrates: search → enrich (seller + price history) → score → store.
 * Records a CollectionRun row so the dashboard can show "last collected X minutes ago".
 *
 * Mode A (API Direct): the default — calls jiji-client which tries live API
 * and falls back to synthetic data if the live endpoint is unreachable.
 *
 * Mode B (Browser Fallback): NOT included here. The operator would wire in
 * DrissionPage/CloudflareBypasser via a separate mini-service. This module
 * is the legitimate, public-API-only path.
 */

import { db } from "./db";
import { jiji, type JijiListing } from "./jiji-client";
import { scoreDeal } from "./deal-scorer";
import { medianPrice } from "./price-analysis";

const SEED_QUERIES = [
  "iphone",
  "ps5",
  "samsung",
  "macbook",
  "laptop",
  "tv",
  "airpods",
  "ipad",
];

export interface CollectionSummary {
  runId: string;
  itemsCollected: number;
  itemsUpdated: number;
  fakeDiscounts: number;
  scamsFlagged: number;
  durationMs: number;
  sourceMode: "api" | "browser";
  log: string[];
}

/**
 * Upsert a seller into the DB.
 */
async function upsertSeller(seller: JijiListing["seller"]) {
  // The phone_leak signal: seller.hide_phone=true BUT phone is non-null.
  const phoneLeaked = seller.hide_phone && !!seller.phone;
  await db.seller.upsert({
    where: { id: seller.id },
    create: {
      id: seller.id,
      username: seller.username,
      location: seller.location,
      accountAgeDays: seller.account_age_days,
      totalListings: seller.total_items,
      rating: seller.rating,
      hidePhone: seller.hide_phone,
      phoneLeaked,
      phone: seller.phone,
      verifiedBadge: seller.verified_badge,
    },
    update: {
      username: seller.username,
      location: seller.location,
      accountAgeDays: seller.account_age_days,
      totalListings: seller.total_items,
      rating: seller.rating,
      hidePhone: seller.hide_phone,
      phoneLeaked,
      phone: seller.phone,
      verifiedBadge: seller.verified_badge,
    },
  });
  return phoneLeaked;
}

/**
 * Upsert a listing + its price history into the DB.
 */
async function upsertListing(item: JijiListing): Promise<{
  isNew: boolean;
  marketMedian: number;
}> {
  // Compute market median from existing listings in the same category.
  // For brand-new categories (first listing), use the listing's own price as a placeholder.
  const sameCategory = await db.listing.findMany({
    where: { category: item.category },
    select: { price: true },
  });
  const marketPrices = sameCategory.map((l) => l.price);
  if (marketPrices.length === 0) marketPrices.push(item.price);
  const marketMedian = medianPrice(marketPrices);

  // Check existing price-history count for this listing
  const existing = await db.listing.findUnique({ where: { id: item.id } });
  const isNew = !existing;

  await db.listing.upsert({
    where: { id: item.id },
    create: {
      id: item.id,
      title: item.title,
      price: item.price,
      currency: item.currency,
      category: item.category,
      condition: item.condition,
      location: item.location,
      imageUrl: item.images[0]?.url ?? null,
      imageCount: item.images.length,
      views: item.views,
      daysOnMarket: item.days_on_market,
      url: item.url,
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
      daysOnMarket: item.days_on_market,
      url: item.url,
      sellerId: item.seller.id,
    },
  });

  // If we found a price history mismatch (new price not the latest), append a new point.
  if (existing) {
    const latestHistory = await db.priceHistory.findFirst({
      where: { listingId: item.id },
      orderBy: { recordedAt: "desc" },
    });
    const expectedLatest = item.price_history[item.price_history.length - 1]?.price;
    if (latestHistory?.price !== expectedLatest && expectedLatest != null) {
      await db.priceHistory.create({
        data: {
          listingId: item.id,
          price: expectedLatest,
          recordedAt: new Date(),
        },
      });
    }
  }

  return { isNew, marketMedian };
}

/**
 * Score a listing and upsert the DealScore row.
 */
async function scoreAndStore(
  item: JijiListing,
  marketMedian: number,
  phoneLeaked: boolean
) {
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
      factors: JSON.stringify(result.factors),
    },
  });

  return result;
}

/**
 * Run a full collection sweep. Iterates seed queries, upserts listings,
 * computes deal scores, and updates the CollectionRun row.
 */
export async function runCollection(opts?: {
  queries?: string[];
  sourceMode?: "api" | "browser";
}): Promise<CollectionSummary> {
  const log: string[] = [];
  const startedAt = Date.now();
  const queries = opts?.queries ?? SEED_QUERIES;
  const sourceMode = opts?.sourceMode ?? "api";

  const run = await db.collectionRun.create({
    data: {
      sourceMode,
      status: "running",
    },
  });
  log.push(`Collection run ${run.id} started (${queries.length} queries, mode=${sourceMode})`);

  let itemsCollected = 0;
  let itemsUpdated = 0;
  let fakeDiscounts = 0;
  let scamsFlagged = 0;

  try {
    for (const q of queries) {
      log.push(`Searching: "${q}"`);
      const result = await jiji.search(q, 1);
      for (const item of result.items) {
        try {
          await upsertSeller(item.seller);
          const { isNew, marketMedian } = await upsertListing(item);
          if (isNew) itemsCollected++;
          else itemsUpdated++;

          const phoneLeaked = item.seller.hide_phone && !!item.seller.phone;
          const score = await scoreAndStore(item, marketMedian, phoneLeaked);
          if (score.hasFakeDiscount) fakeDiscounts++;
          if (score.classification === "SCAM") scamsFlagged++;
        } catch (e: any) {
          log.push(`  ! Failed to upsert ${item.id}: ${e?.message ?? "unknown"}`);
        }
      }
      log.push(`  ${result.items.length} items processed for "${q}"`);
    }

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
      `Collection completed: ${itemsCollected} new, ${itemsUpdated} updated, ${fakeDiscounts} fake discounts, ${scamsFlagged} scams flagged`
    );
  } catch (e: any) {
    log.push(`FATAL: ${e?.message ?? "unknown"}`);
    await db.collectionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), log: log.join("\n") },
    });
    throw e;
  }

  return {
    runId: run.id,
    itemsCollected,
    itemsUpdated,
    fakeDiscounts,
    scamsFlagged,
    durationMs: Date.now() - startedAt,
    sourceMode,
    log,
  };
}

/**
 * Check whether the database is empty (first run).
 */
export async function isDatabaseEmpty(): Promise<boolean> {
  const count = await db.listing.count();
  return count === 0;
}

/**
 * Get the most recent completed collection run for the dashboard header.
 */
export async function getLastRun() {
  return db.collectionRun.findFirst({
    where: { status: "completed" },
    orderBy: { finishedAt: "desc" },
  });
}
