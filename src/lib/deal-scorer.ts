/**
 * Deal Scorer — XGBoost-style gradient-boosted-tree proxy.
 *
 * Now incorporates recon-derived features:
 *   - date_edited / date_moderated churn (rapid edits = distress/scam)
 *   - sold_reported + status=active (ghost listing)
 *   - abuse_reported (previously flagged)
 *   - is_boost + paid_info (commercial intent = broker)
 *   - dealer ratio (adverts_count / feedback_count > 50 = dealer)
 *   - image duplicate signals (relist, cross-seller, cross-market)
 *   - available_tops_count (paying for promotion)
 *
 * Output: 0..100 score bucketed into GREAT / FAIR / RISKY / SCAM.
 */

import { analyzePriceHistory, type PricePoint } from "./price-analysis";

export type DealClass = "GREAT" | "FAIR" | "RISKY" | "SCAM";

export interface DealFeatures {
  // Basic
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

  // Recon-derived — timestamps
  dateCreated: string | null;
  dateEdited: string | null;
  dateModerated: string | null;

  // Recon-derived — flags
  soldReported: boolean;
  status: string; // "active" | "sold" | ...
  canMakeOffer: boolean;
  abuseReported: boolean;
  isBoost: boolean;
  availableTopsCount: number;

  // Seller-level
  advertsCount: number;
  feedbackCount: number;

  // Image duplicate signals (computed by image-hash module)
  imageDuplicateCount: number;
  crossSellerCount: number; // same image under different sellers = stolen photo
  relistCount: number; // same seller, same image, different listing = relist
  crossMarketCount: number; // same image across markets = broker

  // Jiji's own market price valuation (free scam signal)
  priceValuationLow: number | null;
  priceValuationHigh: number | null;
}

export interface DealScoreResult {
  score: number;
  classification: DealClass;
  priceVsMedian: number;
  sellerRisk: number;
  popularityRisk: number;
  priceManipulation: number;
  hasPhoneLeak: boolean;
  hasFakeDiscount: boolean;
  claimedDiscount: number | null;
  realDiscount: number | null;
  // New signals
  editChurn24h: boolean;
  moderationChurn24h: boolean;
  isGhostListing: boolean;
  abuseFlagged: boolean;
  isBoosted: boolean;
  dealerRatio: number;
  crossMarketBroker: boolean;
  imageDuplicateCount: number;
  relistCount: number;
  belowMarketValuation: boolean; // price < Jiji's low valuation band
  aboveMarketValuation: boolean; // price > Jiji's high valuation band
  factors: Record<string, number | string | boolean>;
}

function sigmoid(x: number): number {
  return 100 / (1 + Math.exp(-x));
}

function clamp(x: number, lo = -2, hi = 2): number {
  return Math.max(lo, Math.min(hi, x));
}

function hoursBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const dA = new Date(a).getTime();
  const dB = new Date(b).getTime();
  if (isNaN(dA) || isNaN(dB)) return null;
  return (dB - dA) / 3600000;
}

export function scoreDeal(f: DealFeatures): DealScoreResult {
  // ---- Price signal ----
  const priceVsMedian =
    f.marketMedian > 0 ? (f.marketMedian - f.price) / f.marketMedian : 0;
  const cappedPriceSignal = clamp(priceVsMedian * 4);

  // ---- Seller risk ----
  const ageDays = f.sellerAccountAgeDays;
  const ageSignal = ageDays < 14 ? -1.2 : ageDays < 60 ? -0.3 : ageDays > 365 ? 0.4 : 0;
  const listingSignal =
    f.sellerListingCount < 3 ? -0.8 : f.sellerListingCount < 10 ? -0.2 : 0.4;
  const verifiedSignal = f.hasVerifiedBadge ? 0.4 : 0;

  // ---- Dealer ratio (recon signal) ----
  // adverts_count / feedback_count > 50 = dealer posing as individual
  const denom = Math.max(f.feedbackCount, 1);
  const dealerRatio = f.advertsCount / denom;
  const dealerSignal = dealerRatio > 50 ? -1.0 : dealerRatio > 20 ? -0.4 : 0;

  const sellerRisk = Math.max(
    0,
    Math.min(1, (-ageSignal - listingSignal - dealerSignal) / 3 + (f.hasVerifiedBadge ? 0 : 0.15))
  );

  // ---- Popularity ----
  const viewsPerDay = f.daysOnMarket > 0 ? f.views / f.daysOnMarket : f.views;
  let popularitySignal: number;
  if (viewsPerDay < 2) popularitySignal = -0.5;
  else if (viewsPerDay < 5) popularitySignal = 0;
  else if (viewsPerDay <= 80) popularitySignal = 0.3;
  else if (viewsPerDay <= 200) popularitySignal = 0.1;
  else popularitySignal = -0.2;
  const popularityRisk = viewsPerDay < 2 ? 0.7 : viewsPerDay > 200 ? 0.4 : 0.1;

  // ---- Photo count ----
  const photoSignal = f.photoCount === 0 ? -1.0 : f.photoCount < 3 ? -0.3 : 0.3;

  // ---- Price manipulation (V-curve) ----
  const analysis = analyzePriceHistory(f.priceHistory);
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
    manipulationSignal = 0.2;
    claimedDiscount = analysis.real_discount;
    realDiscount = analysis.real_discount;
  }

  // ---- Phone leak ----
  const leakSignal = f.hasPhoneLeak ? -1.0 : 0;

  // ---- Churn signals (recon) ----
  const editHours = hoursBetween(f.dateCreated, f.dateEdited);
  const moderationHours = hoursBetween(f.dateCreated, f.dateModerated);
  const editChurn24h = editHours != null && editHours < 24;
  const moderationChurn24h = moderationHours != null && moderationHours < 1;
  const churnSignal =
    (editChurn24h ? -0.6 : 0) + (moderationChurn24h ? -1.0 : 0);

  // ---- Ghost listing (recon) ----
  const isGhostListing = f.soldReported && f.status === "active";
  const ghostSignal = isGhostListing ? -0.8 : 0;

  // ---- Abuse flag (recon) ----
  const abuseFlagged = f.abuseReported;
  const abuseSignal = abuseFlagged ? -1.5 : 0;

  // ---- Boost / paid promotion (recon: commercial intent) ----
  const isBoosted = f.isBoost || f.availableTopsCount > 0;
  const boostSignal = isBoosted ? -0.3 : 0;

  // ---- Image duplicate signals (recon) ----
  // cross-seller (stolen photo) is the strongest signal
  const crossSellerSignal = f.crossSellerCount > 1 ? -1.2 : 0;
  const relistSignal = f.relistCount > 0 ? -0.4 : 0; // relist is weaker — could be legitimate
  const crossMarketBroker = f.crossMarketCount > 1;
  const crossMarketSignal = crossMarketBroker ? -0.8 : 0;

  // ---- Price valuation signal (recon: Jiji's own market band) ----
  // Jiji computes a low/high market band. If price is below the low band, that's
  // a strong scam signal (too good to be true). If above, it's just overpriced.
  const belowMarketValuation =
    f.priceValuationLow != null && f.price < f.priceValuationLow * 0.85;
  const aboveMarketValuation =
    f.priceValuationHigh != null && f.price > f.priceValuationHigh * 1.15;
  const valuationSignal = belowMarketValuation ? -1.0 : aboveMarketValuation ? -0.2 : 0;

  // ---- Composite score ----
  const raw =
    cappedPriceSignal * 1.2 +
    ageSignal * 0.8 +
    listingSignal * 0.7 +
    verifiedSignal * 0.5 +
    dealerSignal * 0.9 +
    popularitySignal * 0.5 +
    photoSignal * 0.4 +
    manipulationSignal * 1.4 +
    leakSignal * 0.9 +
    churnSignal * 0.8 +
    ghostSignal * 0.7 +
    abuseSignal * 1.3 +
    boostSignal * 0.4 +
    crossSellerSignal * 1.1 +
    relistSignal * 0.5 +
    crossMarketSignal * 0.7 +
    valuationSignal * 0.8;

  const score = sigmoid(raw);

  // ---- Classification ----
  let classification: DealClass;
  const strongScamSignal =
    abuseFlagged ||
    (f.hasPhoneLeak && hasFakeDiscount) ||
    f.crossSellerCount > 1 ||
    isGhostListing;

  if (strongScamSignal) classification = "SCAM";
  else if (sellerRisk > 0.5) classification = "RISKY";
  else if (score >= 70) classification = "GREAT";
  else if (score >= 55) classification = "FAIR";
  else classification = "RISKY";

  const factors: Record<string, number | string | boolean> = {
    price_vs_median: Number(priceVsMedian.toFixed(3)),
    seller_listing_count: f.sellerListingCount,
    seller_account_age_days: f.sellerAccountAgeDays,
    photo_count: f.photoCount,
    views_per_day: Number(viewsPerDay.toFixed(1)),
    has_verified_badge: f.hasVerifiedBadge,
    dealer_ratio: Number(dealerRatio.toFixed(2)),
    adverts_count: f.advertsCount,
    feedback_count: f.feedbackCount,
    price_manipulation_type: analysis.type,
    has_phone_leak: f.hasPhoneLeak,
    edit_churn_24h: editChurn24h,
    moderation_churn_24h: moderationChurn24h,
    is_ghost_listing: isGhostListing,
    abuse_reported: abuseFlagged,
    is_boosted: isBoosted,
    available_tops_count: f.availableTopsCount,
    image_duplicate_count: f.imageDuplicateCount,
    cross_seller_count: f.crossSellerCount,
    relist_count: f.relistCount,
    cross_market_broker: crossMarketBroker,
    below_market_valuation: belowMarketValuation,
    above_market_valuation: aboveMarketValuation,
    price_valuation_low: f.priceValuationLow ?? "—",
    price_valuation_high: f.priceValuationHigh ?? "—",
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
    editChurn24h,
    moderationChurn24h,
    isGhostListing,
    abuseFlagged,
    isBoosted,
    dealerRatio: Number(dealerRatio.toFixed(2)),
    crossMarketBroker,
    imageDuplicateCount: f.imageDuplicateCount,
    relistCount: f.relistCount,
    belowMarketValuation,
    aboveMarketValuation,
    factors,
  };
}
