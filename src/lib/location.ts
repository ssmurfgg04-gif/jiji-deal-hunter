/**
 * Location-based recommendation engine.
 *
 * Computes geographic distance between buyer and seller, then adjusts deal
 * scores accordingly. A seller 500km away has higher shipping-scam risk than
 * one 5km away.
 *
 * Inspired by SedemQuame/tonaton-scraper's location-based recommendation,
 * which uses seller location as a primary feature.
 *
 * Uses the haversine formula for great-circle distance. Location data comes
 * from Jiji's `region.name` / `city.name` fields. For Kenyan cities we ship
 * a static coordinate table (no API key required).
 */

// ---------------------------------------------------------------------------
// Coordinate table — major Kenyan cities + neighboring capitals.
// Extend as needed. Sourced from public geodata (WGS84 lat/lon).
// ---------------------------------------------------------------------------

const COORDS: Record<string, { lat: number; lon: number }> = {
  // Kenya
  nairobi: { lat: -1.2864, lon: 36.8172 },
  mombasa: { lat: -4.0435, lon: 39.6682 },
  kisumu: { lat: -0.0917, lon: 34.768 },
  nakuru: { lat: -0.3031, lon: 36.08 },
  eldoret: { lat: 0.5143, lon: 35.2698 },
  thika: { lat: -1.0333, lon: 37.0692 },
  kiambu: { lat: -1.1714, lon: 36.8356 },
  machakos: { lat: -1.5167, lon: 37.2667 },
  kikuyu: { lat: -1.2525, lon: 36.6744 },
  ruiru: { lat: -1.1444, lon: 36.9617 },
  syokimau: { lat: -1.3514, lon: 36.8917 },
  karen: { lat: -1.3197, lon: 36.7072 },
  nyeri: { lat: -0.4201, lon: 36.9476 },
  meru: { lat: 0.0463, lon: 37.6456 },
  kakamega: { lat: 0.2827, lon: 34.7519 },
  bungoma: { lat: 0.5686, lon: 34.5606 },
  malindi: { lat: -3.2194, lon: 40.1167 },
  lamu: { lat: -2.1611, lon: 40.9022 },
  garissa: { lat: -0.4539, lon: 39.6461 },
  wajir: { lat: 1.7472, lon: 40.0686 },
  // Nigeria (for cross-market comparison)
  lagos: { lat: 6.5244, lon: 3.3792 },
  abuja: { lat: 9.0765, lon: 7.3986 },
  // Ghana
  accra: { lat: 5.6037, lon: -0.187 },
  // Tanzania
  "dar es salaam": { lat: -6.7924, lon: 39.2083 },
  arusha: { lat: -3.3869, lon: 36.683 },
  // Uganda
  kampala: { lat: 0.3476, lon: 32.5825 },
};

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Resolve a location string to coordinates.
 * Tries exact match, then case-insensitive, then partial match.
 */
export function resolveLocation(location: string | null | undefined): GeoPoint | null {
  if (!location) return null;
  const normalized = location.trim().toLowerCase();
  if (COORDS[normalized]) return COORDS[normalized];
  // Partial match
  for (const [key, coord] of Object.entries(COORDS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return coord;
    }
  }
  return null;
}

/**
 * Haversine distance between two points, in km.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius in km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface LocationRisk {
  buyerCoord: GeoPoint | null;
  sellerCoord: GeoPoint | null;
  distanceKm: number | null;
  riskScore: number; // 0..1, higher = riskier
  riskLabel: "local" | "regional" | "distant" | "cross-border" | "unknown";
}

/**
 * Compute location-based risk for a listing given a buyer location.
 *
 * Risk calibration:
 *   - < 50km   → local, low risk (0.0)
 *   - 50-300km → regional, slight risk (0.2)
 *   - 300-1000km → distant, moderate risk (0.5)
 *   - > 1000km  → cross-border, high risk (0.9) — shipping scam territory
 *   - unknown   → can't compute, neutral (0.3)
 */
export function computeLocationRisk(
  sellerLocation: string | null,
  buyerLocation: string | null
): LocationRisk {
  const buyerCoord = resolveLocation(buyerLocation);
  const sellerCoord = resolveLocation(sellerLocation);

  if (!buyerCoord || !sellerCoord) {
    return {
      buyerCoord,
      sellerCoord,
      distanceKm: null,
      riskScore: 0.3,
      riskLabel: "unknown",
    };
  }

  const distanceKm = haversineKm(buyerCoord, sellerCoord);

  let riskScore: number;
  let riskLabel: LocationRisk["riskLabel"];
  if (distanceKm < 50) {
    riskScore = 0.0;
    riskLabel = "local";
  } else if (distanceKm < 300) {
    riskScore = 0.2;
    riskLabel = "regional";
  } else if (distanceKm < 1000) {
    riskScore = 0.5;
    riskLabel = "distant";
  } else {
    riskScore = 0.9;
    riskLabel = "cross-border";
  }

  return { buyerCoord, sellerCoord, distanceKm, riskScore, riskLabel };
}

/**
 * List of known locations (for the buyer-location dropdown in the UI).
 */
export const KNOWN_LOCATIONS = Object.keys(COORDS).sort();
