/**
 * Deal Scorer — XGBoost-style gradient-boosted-tree proxy.
 *
 * A real XGBoost model would be trained offline on labeled (scam/legit) pairs.
 * We approximate it here with a weighted-feature scoring function calibrated to
 * produce a 0..100 score, then bucketed into GREAT / FAIR / RISKY / SCAM.
 *
 * Features (sourced from API fields where possible, NOT HTML scraping):
 *   1. price_vs_median       — how far below market median (lower = better deal)
 *   2. seller_listing_count  — established sellers are safer
 *   3. seller_account_age    — older accounts are safer
 *   4. photo_count           — listings with multiple photos are more trustworthy
 *   5. views_per_day         — popularity signal (sweet spot, not too low/high)
 *   6. price_drop_count     — sellers who drop price repeatedly may be motivated,
 *                              or may be running a fake-discount V-curve
 *   7. has_phone_leak       — seller hid phone but API still exposes it.
 *                              Strong scam-or-careless signal.
 *
 * The has_phone_leak feature is unique to recon against the seller/data.json
 * endpoint and is a high-information signal: legitimate sellers don't hide
 * their phone. A seller who toggles hide_phone=1 but the API still leaks it
 * is either (a) trying to look legitimate while routing victims off-platform,
 * or (b) careless about their own privacy settings. Both correlate with scam.
 */

import { analyzePriceHistory, type PricePoint, type PriceAnalysis } from "./price-analysis";

export type DealClass = "GREAT" | "FAIR" | "RISKY" | "SCAM";

export interface DealFeatures {
  price: number;
  marketMedian: number;
  sellerListingCount: number;
  sellerAccountAgeDays: number;
  photoCount: number;
  views: number;
  daysOnMarket: number;
  hasPhoneLeak: boolean;
  hasVerifiedBadge: boolean;
  priceHistory: PricePoint[];
}

export interface DealScoreResult {
  score: number; // 0..100, higher = better deal
  classification: DealClass;
  priceVsMedian: number; // (median - price) / median, positive = below market
  sellerRisk: number; // 0..1, higher = riskier seller
  popularityRisk: number; // 0..1
  priceManipulation: number; // 0..1
  hasPhoneLeak: boolean;
  hasFakeDiscount: boolean;
  claimedDiscount: number | null;
  realDiscount: number | null;
  factors: Record<string, number | string | boolean>;
}

/**
 * Sigmoid helper for squashing raw scores to 0..100.
 */
function sigmoid(x: number): number {
  return 100 / (1 + Math.exp(-x));
}

/**
 * Scaled feature → 0..1 contribution (negative = bad, positive = good).
 */
function clamp(x: number, lo = -2, hi = 2): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Compute the deal score from raw features.
 *
 * Returns a structured object with both the headline score and the
 * underlying feature values for SHAP-style explainability in the UI.
 */
export function scoreDeal(f: DealFeatures): DealScoreResult {
  // ---- Price signal ----
  const priceVsMedian =
    f.marketMedian > 0 ? (f.marketMedian - f.price) / f.marketMedian : 0;
  // Big discounts get capped — anything beyond -50% vs market is suspicious.
  const cappedPriceSignal = clamp(priceVsMedian * 4);

  // ---- Seller risk ----
  // New sellers (account age < 14 days) get heavy penalty.
  const ageDays = f.sellerAccountAgeDays;
  const ageSignal = ageDays < 14 ? -1.2 : ageDays < 60 ? -0.3 : ageDays > 365 ? 0.4 : 0;

  // Low listing count = broker or one-off scammer
  const listingSignal =
    f.sellerListingCount < 3 ? -0.8 : f.sellerListingCount < 10 ? -0.2 : 0.4;

  // Verified badge
  const verifiedSignal = f.hasVerifiedBadge ? 0.4 : 0;

  const sellerRisk = Math.max(
    0,
    Math.min(1, (-ageSignal - listingSignal) / 2 + (f.hasVerifiedBadge ? 0 : 0.2))
  );

  // ---- Popularity ----
  const viewsPerDay = f.daysOnMarket > 0 ? f.views / f.daysOnMarket : f.views;
  // Sweet spot: 5..80 views/day. Below 2 = no one's looking (suspicious).
  // Above 200 = maybe hot, but also could be honeypot.
  let popularitySignal: number;
  if (viewsPerDay < 2) popularitySignal = -0.5;
  else if (viewsPerDay < 5) popularitySignal = 0;
  else if (viewsPerDay <= 80) popularitySignal = 0.3;
  else if (viewsPerDay <= 200) popularitySignal = 0.1;
  else popularitySignal = -0.2;
  const popularityRisk = viewsPerDay < 2 ? 0.7 : viewsPerDay > 200 ? 0.4 : 0.1;

  // ---- Photo count ----
  const photoSignal = f.photoCount === 0 ? -1.0 : f.photoCount < 3 ? -0.3 : 0.3;

  // ---- Price manipulation ----
  const analysis: PriceAnalysis = analyzePriceHistory(f.priceHistory);
  let manipulationSignal = 0;
  let claimedDiscount: number | null = null;
  let realDiscount: number | null = null;
  let hasFakeDiscount = false;
  if (analysis.type === "fake_discount") {
    manipulationSignal = -1.5 * analysis.confidence;
    claimedDiscount = analysis.claimed_discount;
    realDiscount = analysis.real_discount;
    hasFakeDiscount = true;
  } else if (analysis.type === "steady_discount") {
    manipulationSignal = 0.2; // real discount = good signal
    claimedDiscount = analysis.real_discount;
    realDiscount = analysis.real_discount;
  }

  // ---- Phone leak (the recon-specific signal) ----
  const leakSignal = f.hasPhoneLeak ? -1.0 : 0;

  // ---- Composite score ----
  const raw =
    cappedPriceSignal * 1.2 +
    ageSignal * 0.8 +
    listingSignal * 0.7 +
    verifiedSignal * 0.5 +
    popularitySignal * 0.5 +
    photoSignal * 0.4 +
    manipulationSignal * 1.4 +
    leakSignal * 0.9;

  const score = sigmoid(raw);

  // ---- Classification ----
  let classification: DealClass;
  if (f.hasPhoneLeak && hasFakeDiscount) classification = "SCAM";
  else if (score >= 70 && sellerRisk < 0.5) classification = "GREAT";
  else if (score >= 55 && sellerRisk < 0.7) classification = "FAIR";
  else if (hasFakeDiscount || f.hasPhoneLeak || sellerRisk > 0.7) classification = "RISKY";
  else if (score < 40) classification = "RISKY";
  else classification = "FAIR";

  // SCAM override
  if (score < 30 || (f.hasPhoneLeak && hasFakeDiscount && sellerRisk > 0.8)) {
    classification = "SCAM";
  }

  const factors: Record<string, number | string | boolean> = {
    price_vs_median: Number(priceVsMedian.toFixed(3)),
    seller_listing_count: f.sellerListingCount,
    seller_account_age_days: f.sellerAccountAgeDays,
    photo_count: f.photoCount,
    views_per_day: Number(viewsPerDay.toFixed(1)),
    has_verified_badge: f.hasVerifiedBadge,
    price_manipulation_type: analysis.type,
    has_phone_leak: f.hasPhoneLeak,
    raw_score: Number(raw.toFixed(3)),
  };

  return {
    score: Number(score.toFixed(1)),
    classification,
    priceVsMedian: Number(priceVsMedian.toFixed(3)),
    sellerRisk: Number(sellerRisk.toFixed(3)),
    popularityRisk: Number(popularityRisk.toFixed(3)),
    priceManipulation: hasFakeDiscount ? (analysis as any).confidence : 0,
    hasPhoneLeak: f.hasPhoneLeak,
    hasFakeDiscount,
    claimedDiscount: claimedDiscount != null ? Number(claimedDiscount.toFixed(3)) : null,
    realDiscount: realDiscount != null ? Number(realDiscount.toFixed(3)) : null,
    factors,
  };
}
