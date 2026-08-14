#!/usr/bin/env bun
/**
 * Re-score all listings in the DB.
 *
 * For each listing:
 *   1. Load seller + price history
 *   2. Compute image duplicate signals
 *   3. Run the weighted-features scorer (src/lib/deal-scorer.ts)
 *   4. Upsert the DealScore row
 *
 * Usage: bun scripts/rescore.ts
 */

import { PrismaClient } from "@prisma/client";
import { scoreDeal } from "../src/lib/deal-scorer";
import { medianPrice } from "../src/lib/price-analysis";
import { indexListingImages, getListingDuplicateSignals } from "../src/lib/image-hash";

const db = new PrismaClient();

async function main() {
  console.log("[rescore] Loading all listings...");
  const listings = await db.listing.findMany({
    include: {
      seller: true,
      priceHistory: true,
      dealScore: true,
    },
  });
  console.log(`[rescore] Found ${listings.length} listings`);

  // Compute per-category median (in-memory)
  // Convert BigInt prices to Number for median computation
  const byCategory: Record<string, number[]> = {};
  for (const l of listings) {
    (byCategory[l.category] ??= []).push(Number(l.price));
  }
  const medians: Record<string, number> = {};
  for (const [cat, prices] of Object.entries(byCategory)) {
    medians[cat] = medianPrice(prices);
  }

  let scored = 0;
  let fakeDiscounts = 0;
  let scams = 0;

  for (const l of listings) {
    const marketMedian = medians[l.category] ?? l.price;

    // Index images first (so dup signals are available)
    if (l.imageUrl) {
      const images = [l.imageUrl];
      // Also index any other images we may have stored historically
      try {
        await indexListingImages({
          marketId: l.marketId,
          listingId: l.id,
          sellerId: l.sellerId,
          imageUrls: images,
        });
      } catch {
        // ignore
      }
    }

    const dupSignals = await getListingDuplicateSignals(l.id);

    const phoneLeaked = l.seller.hidePhone && !!l.seller.phone;
    const result = scoreDeal({
      price: Number(l.price),
      marketMedian,
      sellerListingCount: l.seller.totalListings,
      sellerAccountAgeDays: l.seller.accountAgeDays,
      photoCount: l.imageCount,
      views: l.views,
      daysOnMarket: l.daysOnMarket,
      hasPhoneLeak: phoneLeaked,
      hasVerifiedBadge: l.seller.verifiedBadge,
      priceHistory: l.priceHistory.map((p) => ({
        price: p.price,
        recorded_at: p.recordedAt.toISOString(),
      })),
      dateCreated: l.dateCreated?.toISOString() ?? null,
      dateEdited: l.dateEdited?.toISOString() ?? null,
      dateModerated: l.dateModerated?.toISOString() ?? null,
      soldReported: l.soldReported,
      status: l.status,
      canMakeOffer: l.canMakeOffer,
      abuseReported: l.abuseReported,
      isBoost: l.isBoost,
      availableTopsCount: l.availableTopsCount,
      advertsCount: l.seller.advertsCount,
      feedbackCount: l.seller.feedbackCount,
      imageDuplicateCount: dupSignals.imageDuplicateCount,
      crossSellerCount: dupSignals.crossSellerCount,
      relistCount: dupSignals.relistCount,
      crossMarketCount: dupSignals.crossMarketCount,
      priceValuationLow: l.priceValuationLow != null ? Number(l.priceValuationLow) : null,
      priceValuationHigh: l.priceValuationHigh != null ? Number(l.priceValuationHigh) : null,
    });

    await db.dealScore.upsert({
      where: { listingId: l.id },
      create: {
        listingId: l.id,
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

    scored++;
    if (result.hasFakeDiscount) fakeDiscounts++;
    if (result.classification === "SCAM") scams++;
  }

  console.log(
    `[rescore] Done. Scored: ${scored}, Fake discounts: ${fakeDiscounts}, Scams: ${scams}`
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[rescore] FATAL:", e);
  process.exit(1);
});
