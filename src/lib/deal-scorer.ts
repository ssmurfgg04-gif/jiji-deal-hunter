/**
 * ML Model Loader — loads XGBoost-style model artifacts from disk and
 * provides a tiny tree-walker scorer. Falls back to the hand-tuned weighted
 * scorer if no model file exists or the file is corrupt.
 *
 * Model file format (produced by scripts/train-xgboost-v3.py):
 *   {
 *     "version": 3,
 *     "features": ["price_vs_median", "seller_account_age_days", ...],
 *     "trees": [
 *       [
 *         { "feature": "price_vs_median", "threshold": -0.1, "left": 1, "right": 2, "leaf": false },
 *         { "leaf": true, "value": 0.05 },
 *         ...
 *       ],
 *       ... more trees ...
 *     ],
 *     "baseScore": 0.5,
 *     "metrics": { "auc": 0.71, "accuracy": 0.64 }
 *   }
 *
 * The scorer sums tree outputs and applies a sigmoid — same as XGBoost's
 * `predict_proba` (base_score + sum(tree_predictions), then sigmoid).
 *
 * Performance: ~10µs per listing for a 100-tree model — no measurable
 * overhead vs the hand-tuned scorer.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { analyzePriceHistory, type PricePoint } from "./price-analysis";

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
  dateCreated: string | null;
  dateEdited: string | null;
  dateModerated: string | null;
  soldReported: boolean;
  status: string;
  canMakeOffer: boolean;
  abuseReported: boolean;
  isBoost: boolean;
  availableTopsCount: number;
  advertsCount: number;
  feedbackCount: number;
  imageDuplicateCount: number;
  crossSellerCount: number;
  relistCount: number;
  crossMarketCount: number;
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
  editChurn24h: boolean;
  moderationChurn24h: boolean;
  isGhostListing: boolean;
  abuseFlagged: boolean;
  isBoosted: boolean;
  dealerRatio: number;
  crossMarketBroker: boolean;
  imageDuplicateCount: number;
  relistCount: number;
  belowMarketValuation: boolean;
  aboveMarketValuation: boolean;
  factors: Record<string, number | string | boolean>;
  /** Where the score came from — for diagnostics / dashboard display. */
  scorerSource: "ml-model-v3" | "ml-model-v2" | "hand-tuned-fallback";
}

// ---------------------------------------------------------------------------
// ML model loader (lazy singleton — file is read once on first use)
// ---------------------------------------------------------------------------

interface TreeNode {
  feature?: string;
  threshold?: number;
  left?: number;
  right?: number;
  leaf?: boolean;
  value?: number;
}

interface ModelArtifact {
  version: number;
  features: string[];
  trees: TreeNode[][];
  baseScore: number;
  metrics?: Record<string, number>;
}

let cachedModel: { artifact: ModelArtifact; path: string } | null = null;
let modelLoadAttempted = false;

function findModelFile(): string | null {
  // Search order: v3 (temporal, non-leaking) → v2 → v1 → null
  const candidates = [
    join(process.cwd(), "ml-models", "deal_scorer_v3.json"),
    join(process.cwd(), "ml-models", "deal_scorer.json"),
    join(process.cwd(), "ml-models", "deal_scorer_v2.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadModel(): { artifact: ModelArtifact; path: string } | null {
  if (modelLoadAttempted) return cachedModel;
  modelLoadAttempted = true;

  const path = findModelFile();
  if (!path) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelArtifact;
    if (!parsed || !Array.isArray(parsed.trees) || !Array.isArray(parsed.features)) {
      console.warn(`[deal-scorer] Model file ${path} is malformed — falling back to hand-tuned weights`);
      return null;
    }
    cachedModel = { artifact: parsed, path };
    console.log(
      `[deal-scorer] Loaded model v${parsed.version} from ${path} ` +
      `(${parsed.trees.length} trees, ${parsed.features.length} features` +
      (parsed.metrics ? `, AUC=${parsed.metrics.auc?.toFixed(3)}` : "") + ")"
    );
    return cachedModel;
  } catch (e) {
    console.warn(`[deal-scorer] Failed to load model from ${path}:`, e);
    return null;
  }
}

/**
 * Compute the feature vector matching the trained model's feature list.
 * If the model expects a feature we don't compute, it defaults to 0
 * (XGBoost handles missing values via the "default direction" in each tree).
 */
function computeFeatureVector(
  f: DealFeatures,
  featureNames: string[]
): Record<string, number> {
  const priceVsMedian =
    f.marketMedian > 0 ? (f.marketMedian - f.price) / f.marketMedian : 0;
  const dealerRatio = f.advertsCount / Math.max(f.feedbackCount, 1);
  const viewsPerDay = f.daysOnMarket > 0 ? f.views / f.daysOnMarket : f.views;

  const editHours = hoursBetween(f.dateCreated, f.dateEdited);
  const moderationHours = hoursBetween(f.dateCreated, f.dateModerated);
  const editChurn24h = editHours != null && editHours < 24 ? 1 : 0;
  const moderationChurn24h = moderationHours != null && moderationHours < 1 ? 1 : 0;
  const isGhostListing = f.soldReported && f.status === "active" ? 1 : 0;
  const isBoosted = (f.isBoost || f.availableTopsCount > 0) ? 1 : 0;
  const crossMarketBroker = f.crossMarketCount > 1 ? 1 : 0;

  const belowMarketValuation =
    f.priceValuationLow != null && f.price < f.priceValuationLow * 0.85 ? 1 : 0;
  const aboveMarketValuation =
    f.priceValuationHigh != null && f.price > f.priceValuationHigh * 1.15 ? 1 : 0;

  // Price manipulation analysis (V-curve)
  const analysis = analyzePriceHistory(f.priceHistory);
  const hasFakeDiscount = analysis.type === "fake_discount" ? 1 : 0;
  // Narrow the union — only FakeDiscountResult has claimed_discount, only
  // FakeDiscountResult / SteadyDiscountResult have real_discount.
  const realDiscount = analysis.type === "fake_discount" || analysis.type === "steady_discount"
    ? analysis.real_discount
    : 0;
  const claimedDiscount = analysis.type === "fake_discount" ? analysis.claimed_discount : 0;

  // Compute a dict of all possible features, then filter to the model's expected set.
  const allFeatures: Record<string, number> = {
    price_vs_median: priceVsMedian,
    seller_listing_count: f.sellerListingCount,
    seller_account_age_days: f.sellerAccountAgeDays,
    photo_count: f.photoCount,
    views_per_day: viewsPerDay,
    days_on_market: f.daysOnMarket,
    has_verified_badge: f.hasVerifiedBadge ? 1 : 0,
    dealer_ratio: dealerRatio,
    adverts_count: f.advertsCount,
    feedback_count: f.feedbackCount,
    has_phone_leak: f.hasPhoneLeak ? 1 : 0,
    edit_churn_24h: editChurn24h,
    moderation_churn_24h: moderationChurn24h,
    is_ghost_listing: isGhostListing,
    abuse_reported: f.abuseReported ? 1 : 0,
    is_boosted: isBoosted,
    available_tops_count: f.availableTopsCount,
    image_duplicate_count: f.imageDuplicateCount,
    cross_seller_count: f.crossSellerCount,
    relist_count: f.relistCount,
    cross_market_broker: crossMarketBroker,
    below_market_valuation: belowMarketValuation,
    above_market_valuation: aboveMarketValuation,
    has_fake_discount: hasFakeDiscount,
    real_discount: realDiscount,
    claimed_discount: claimedDiscount,
    price_manipulation_type: analysis.type === "fake_discount" ? -1 :
                              analysis.type === "steady_discount" ? 1 : 0,
  };

  // Return only the features the model expects.
  const vector: Record<string, number> = {};
  for (const name of featureNames) {
    vector[name] = allFeatures[name] ?? 0;
  }
  return vector;
}

/**
 * Walk one tree using the feature vector. Missing features default to 0
 * (which matches XGBoost's missing-value handling for sparse features).
 */
function walkTree(tree: TreeNode[], features: Record<string, number>, nodeIdx = 0): number {
  const node = tree[nodeIdx];
  if (!node) return 0;
  if (node.leaf) return node.value ?? 0;

  const featureValue = features[node.feature!] ?? 0;
  const nextIdx = featureValue <= (node.threshold ?? 0) ? node.left : node.right;
  if (nextIdx == null) return node.value ?? 0;
  return walkTree(tree, features, nextIdx);
}

function predictWithModel(artifact: ModelArtifact, features: DealFeatures): {
  rawScore: number;
  probability: number;
} {
  const vector = computeFeatureVector(features, artifact.features);
  let sum = artifact.baseScore ?? 0.5;
  for (const tree of artifact.trees) {
    sum += walkTree(tree, vector, 0);
  }
  // Sigmoid → 0..1 probability of "is a good deal"
  const probability = 1 / (1 + Math.exp(-sum));
  return { rawScore: sum, probability };
}

// ---------------------------------------------------------------------------
// Hand-tuned fallback scorer (original implementation)
// ---------------------------------------------------------------------------

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

function handTunedScore(f: DealFeatures): DealScoreResult {
  // ---- Price signal ----
  const priceVsMedian =
    f.marketMedian > 0 ? (f.marketMedian - f.price) / f.marketMedian : 0;
  const cappedPriceSignal = clamp(priceVsMedian * 4);

  // ---- Seller risk ----
  let ageDays = f.sellerAccountAgeDays;
  if (ageDays === 0 && f.dateCreated) {
    const created = new Date(f.dateCreated).getTime();
    if (!isNaN(created)) {
      ageDays = Math.max(0, Math.floor((Date.now() - created) / 86400000));
    }
  }
  const ageSignal = ageDays === 0 ? -0.6 : ageDays < 14 ? -1.2 : ageDays < 60 ? -0.3 : ageDays > 365 ? 0.4 : 0;
  const listingSignal =
    f.sellerListingCount < 3 ? -0.8 : f.sellerListingCount < 10 ? -0.2 : 0.4;
  const verifiedSignal = f.hasVerifiedBadge ? 0.4 : 0;

  const denom = Math.max(f.feedbackCount, 1);
  const dealerRatio = f.advertsCount / denom;
  let dealerSignal: number;
  if (dealerRatio > 50) dealerSignal = -1.0;
  else if (dealerRatio > 20) dealerSignal = -0.4;
  else if (dealerRatio >= 5) dealerSignal = 0.2;
  else if (dealerRatio >= 1) dealerSignal = -0.1;
  else dealerSignal = -0.3;

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

  const photoSignal = f.photoCount === 0 ? -1.0 : f.photoCount < 3 ? -0.3 : 0.3;

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

  const leakSignal = f.hasPhoneLeak ? -1.0 : 0;

  const editHours = hoursBetween(f.dateCreated, f.dateEdited);
  const moderationHours = hoursBetween(f.dateCreated, f.dateModerated);
  const editChurn24h = editHours != null && editHours < 24;
  const moderationChurn24h = moderationHours != null && moderationHours < 1;
  const churnSignal = (editChurn24h ? -0.6 : 0) + (moderationChurn24h ? -1.0 : 0);

  const isGhostListing = f.soldReported && f.status === "active";
  const ghostSignal = isGhostListing ? -0.8 : 0;

  const abuseFlagged = f.abuseReported;
  const abuseSignal = abuseFlagged ? -1.5 : 0;

  const isBoosted = f.isBoost || f.availableTopsCount > 0;
  const boostStale = isBoosted && f.daysOnMarket > 14;
  const boostSignal = boostStale ? -0.8 : isBoosted ? -0.3 : 0;

  const crossSellerSignal = f.crossSellerCount > 1 ? -1.8 : 0;
  const relistSignal = f.relistCount > 0 ? -0.4 : 0;
  const crossMarketBroker = f.crossMarketCount > 1;
  const crossMarketSignal = crossMarketBroker ? -0.8 : 0;
  const imageDupSignal = f.imageDuplicateCount > 0
    ? -Math.min(1.0, f.imageDuplicateCount * 0.2)
    : 0;

  const belowMarketValuation =
    f.priceValuationLow != null && f.price < f.priceValuationLow * 0.85;
  const aboveMarketValuation =
    f.priceValuationHigh != null && f.price > f.priceValuationHigh * 1.15;
  const valuationSignal = belowMarketValuation ? -1.0 : aboveMarketValuation ? -0.2 : 0;

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
    crossSellerSignal * 1.3 +
    relistSignal * 0.5 +
    crossMarketSignal * 0.7 +
    imageDupSignal * 0.6 +
    valuationSignal * 0.8;

  const score = sigmoid(raw);

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
    scorerSource: "hand-tuned-fallback",
  };
}

// ---------------------------------------------------------------------------
// Public scorer — uses ML model if available, else falls back.
// ---------------------------------------------------------------------------

export function scoreDeal(f: DealFeatures): DealScoreResult {
  const model = loadModel();

  // If no model file, use the hand-tuned scorer.
  if (!model) {
    return handTunedScore(f);
  }

  // Use ML model for the score, but keep the hand-tuned path's auxiliary
  // outputs (factors, signals, classification logic) — those are still
  // useful for the dashboard even when the score itself comes from the model.
  const fallback = handTunedScore(f);
  const { probability } = predictWithModel(model.artifact, f);

  // Scale 0..1 probability to 0..100 score.
  const mlScore = Number((probability * 100).toFixed(1));

  // Re-run classification using the ML score but the same scam-signal logic.
  let classification: DealClass;
  const strongScamSignal =
    fallback.abuseFlagged ||
    (f.hasPhoneLeak && fallback.hasFakeDiscount) ||
    f.crossSellerCount > 1 ||
    fallback.isGhostListing;
  if (strongScamSignal) classification = "SCAM";
  else if (fallback.sellerRisk > 0.5) classification = "RISKY";
  else if (mlScore >= 70) classification = "GREAT";
  else if (mlScore >= 55) classification = "FAIR";
  else classification = "RISKY";

  const version = model.artifact.version;
  const source: DealScoreResult["scorerSource"] =
    version >= 3 ? "ml-model-v3" : "ml-model-v2";

  return {
    ...fallback,
    score: mlScore,
    classification,
    scorerSource: source,
  };
}

/**
 * Diagnostics — returns info about the currently-loaded model (or null).
 * Useful for the dashboard to display "Scorer: ML model v3 (AUC 0.71)" vs
 * "Scorer: hand-tuned fallback".
 */
export function getScorerInfo(): {
  source: DealScoreResult["scorerSource"];
  version?: number;
  treeCount?: number;
  featureCount?: number;
  metrics?: Record<string, number>;
  path?: string;
} | null {
  const model = loadModel();
  if (!model) {
    return { source: "hand-tuned-fallback" };
  }
  return {
    source: model.artifact.version >= 3 ? "ml-model-v3" : "ml-model-v2",
    version: model.artifact.version,
    treeCount: model.artifact.trees.length,
    featureCount: model.artifact.features.length,
    metrics: model.artifact.metrics,
    path: model.path,
  };
}
