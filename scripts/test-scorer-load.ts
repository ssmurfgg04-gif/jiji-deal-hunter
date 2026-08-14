import { scoreDeal } from "../src/lib/deal-scorer";

const features = {
  price: 500000,
  marketMedian: 600000,
  sellerListingCount: 5,
  sellerAccountAgeDays: 30,
  photoCount: 4,
  views: 200,
  daysOnMarket: 21,
  hasPhoneLeak: false,
  hasVerifiedBadge: true,
  priceHistory: [],
  dateCreated: null,
  dateEdited: null,
  dateModerated: null,
  soldReported: false,
  status: "active",
  canMakeOffer: true,
  abuseReported: false,
  isBoost: false,
  availableTopsCount: 0,
  advertsCount: 10,
  feedbackCount: 5,
  imageDuplicateCount: 0,
  crossSellerCount: 0,
  relistCount: 0,
  crossMarketCount: 1,
  priceValuationLow: null,
  priceValuationHigh: null,
};

const result = scoreDeal(features);
console.log("score:", result.score.toFixed(3), "class:", result.classification);
console.log("priceVsMedian:", result.priceVsMedian.toFixed(3));
