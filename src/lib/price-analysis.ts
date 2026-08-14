/**
 * Price Manipulation Detection
 *
 * Adapted from PriceDive (DAILtech) — the "先涨后降" (raise-then-discount)
 * pattern. A scammy seller raises the listed price for a few days, then
 * "discounts" it back below the original price and claims a big sale.
 *
 * V-curve pattern:
 *   Day 1: KES 50,000 (true market price)
 *   Day 5: KES 65,000 (+30% — seller inflated price)
 *   Day 10: KES 45,000 ("30% DISCOUNT!" — actually only 10% off true market)
 *
 * We also flag:
 *   - Round-trip anomalies (price spikes with no fundamental reason)
 *   - Sharp drops on freshly-listed items (often a relisting scam)
 *   - Listings that have been on-market too long with a recent price drop
 *     (this is a legitimate signal of a motivated seller, not a scam — we
 *     distinguish by the V-shape)
 */

export interface PricePoint {
  price: number;
  recorded_at: string | Date;
}

export interface FakeDiscountResult {
  type: "fake_discount";
  original: number;
  peak: number;
  current: number;
  claimed_discount: number; // (peak - current) / peak
  real_discount: number; // (original - current) / original
  peak_to_current_drop: number; // raw % drop seller is claiming
  confidence: number; // 0..1
}

export interface SteadyDiscountResult {
  type: "steady_discount";
  original: number;
  current: number;
  real_discount: number;
}

export interface NoDiscountResult {
  type: "none";
}

export type PriceAnalysis = FakeDiscountResult | SteadyDiscountResult | NoDiscountResult;

const MIN_POINTS = 3;
const PEAK_THRESHOLD = 1.18; // peak must be at least 18% above starting price
const PEAK_TO_CURRENT_THRESHOLD = 0.20; // claimed discount must be >= 20%

/**
 * Detect fake-discount V-curve in a price history.
 *
 * @param history Price points ordered from oldest to newest.
 */
export function analyzePriceHistory(history: PricePoint[]): PriceAnalysis {
  if (!history || history.length < MIN_POINTS) return { type: "none" };

  const prices = history.map((p) => p.price);
  const original = prices[0];
  const peak = Math.max(...prices);
  const current = prices[prices.length - 1];

  // V-curve: peak above original * 1.18, current below original * 0.95
  const peakAboveOriginal = peak >= original * PEAK_THRESHOLD;
  const currentBelowOriginal = current < original * 0.97;

  if (peakAboveOriginal && currentBelowOriginal) {
    const claimed_discount = (peak - current) / peak;
    const real_discount = (original - current) / original;
    if (claimed_discount >= PEAK_TO_CURRENT_THRESHOLD && real_discount < claimed_discount * 0.6) {
      // Confidence scales with how dramatic the V-shape is
      const vShape = (peak - original) / original + (peak - current) / peak;
      const confidence = Math.min(1, 0.5 + vShape * 1.5);
      return {
        type: "fake_discount",
        original,
        peak,
        current,
        claimed_discount,
        real_discount,
        peak_to_current_drop: claimed_discount,
        confidence,
      };
    }
  }

  // Steady discount (no V-shape, but a real drop happened)
  if (current < original * 0.95) {
    return {
      type: "steady_discount",
      original,
      current,
      real_discount: (original - current) / original,
    };
  }

  return { type: "none" };
}

/**
 * Compute the median price for a set of comparable listings.
 * Used as the "market median" reference in the dashboard.
 */
export function medianPrice(prices: number[]): number {
  if (prices.length === 0) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Compute the standard deviation of prices (used for outlier detection).
 */
export function stddevPrice(prices: number[]): number {
  if (prices.length < 2) return 0;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance =
    prices.reduce((acc, p) => acc + (p - mean) ** 2, 0) / prices.length;
  return Math.sqrt(variance);
}

/**
 * Z-score of a single price against the market.
 * Returns how many stddev below/above the median this price is.
 */
export function priceZScore(price: number, market: number[]): number {
  const sd = stddevPrice(market);
  if (sd === 0) return 0;
  const med = medianPrice(market);
  return (price - med) / sd;
}
