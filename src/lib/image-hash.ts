/**
 * Image Hash Extraction & Dedup
 *
 * Recon finding: Jiji image URLs contain a size-invariant content hash.
 *
 * Two formats coexist:
 *
 * MODERN (Dec 2021+):
 *   https://pictures-kenya.jijistatic.com/42634303_MTEyNS0xNTAwLWZjOGE5ZjJhZTE.webp
 *   The base64 segment decodes to "1125-1500-fc8a9f2ae1"
 *   Hash = "fc8a9f2ae1" (last segment after splitting on "-")
 *
 * LEGACY (2020 - mid 2021):
 *   https://ke1.jijistatic.com/42634303_filename_800x600.jpg
 *   Hash = "legacy:42634303:filename" (numeric ID + original filename)
 *
 * Use cases:
 *   1. RELIST DETECTION — same seller, same image hash, different listing GUID
 *   2. SCAM RING DETECTION — different sellers, same image hash = stolen photos
 *   3. CROSS-MARKET BROKER — same hash across Kenya + Nigeria markets
 *
 * Zero-download: extraction happens by parsing the URL string only,
 * no image fetch required. Massively scalable.
 */

import { db } from "./db";

export interface ExtractedHash {
  hash: string;
  hashType: "modern" | "legacy";
}

/**
 * Extract size-invariant content hash from a Jiji image URL.
 * Returns null for URLs that don't match either known format.
 */
export function extractImageHash(url: string): ExtractedHash | null {
  if (!url || typeof url !== "string") return null;

  // MODERN format: {id}_{base64("W-H-hash")}.webp or .jpg
  // Base64 chars: A-Z a-z 0-9 + / = (URL-safe: - _ as well)
  const modernMatch = url.match(/_(?:[A-Za-z0-9+/\-_]+)\.(?:webp|jpg|jpeg|png)$/);
  if (modernMatch) {
    // Extract just the base64 part between _ and .ext
    const b64Match = url.match(/_([A-Za-z0-9+/\-_]+)\.(?:webp|jpg|jpeg|png)$/);
    if (b64Match) {
      try {
        // URL-safe base64 → standard
        const b64 = b64Match[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "===".slice((b64.length + 3) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf-8");
        // Decoded shape: "1125-1500-fc8a9f2ae1"
        const parts = decoded.split("-");
        if (parts.length >= 3) {
          const hash = parts[parts.length - 1];
          // Sanity check: hash should be hex-like, 8-16 chars
          if (/^[a-f0-9]{6,20}$/i.test(hash)) {
            return { hash: hash.toLowerCase(), hashType: "modern" };
          }
        }
      } catch {
        // base64 decode failed — fall through to legacy check
      }
    }
  }

  // LEGACY format: {id}_{filename}_{W}x{H}.jpg
  const legacyMatch = url.match(/(\d+)_(.+?)_(\d+)x(\d+)\.(?:jpg|jpeg|png)$/);
  if (legacyMatch) {
    const [, id, filename] = legacyMatch;
    return { hash: `legacy:${id}:${filename}`, hashType: "legacy" };
  }

  // Final fallback: numeric ID prefix (least specific, but stable across sizes)
  const idMatch = url.match(/(\d{6,})_/);
  if (idMatch) {
    return { hash: `id:${idMatch[1]}`, hashType: "modern" };
  }

  return null;
}

/**
 * Extract hashes from all images of a listing, dedup them, and persist.
 */
export async function indexListingImages(params: {
  marketId: string;
  listingId: string;
  sellerId: string;
  imageUrls: string[];
}): Promise<{ indexed: number; unique: number }> {
  const { marketId, listingId, sellerId, imageUrls } = params;
  const seenHashes = new Set<string>();
  const toCreate: Array<{
    marketId: string;
    listingId: string;
    sellerId: string;
    hash: string;
    hashType: string;
    url: string;
  }> = [];

  // Extract hashes client-side, dedup per-listing
  for (const url of imageUrls) {
    const extracted = extractImageHash(url);
    if (!extracted) continue;
    if (seenHashes.has(extracted.hash)) continue;
    seenHashes.add(extracted.hash);
    toCreate.push({
      marketId,
      listingId,
      sellerId,
      hash: extracted.hash,
      hashType: extracted.hashType,
      url,
    });
  }

  if (toCreate.length === 0) {
    return { indexed: 0, unique: 0 };
  }

  // BATCHED: check which hashes already exist, then createMany only the new ones.
  // SQLite via Prisma 6 doesn't support skipDuplicates on createMany, so we
  // query existing hashes first and exclude them from the batch insert.
  // For 12 images per listing: was 12 round-trips (one upsert per image),
  // now 2 round-trips (1 findMany + 1 createMany) regardless of image count.
  const existingHashes = new Set(
    (
      await db.imageHash.findMany({
        where: {
          listingId,
          hash: { in: toCreate.map((r) => r.hash) },
        },
        select: { hash: true },
      })
    ).map((r) => r.hash)
  );

  const newRows = toCreate.filter((r) => !existingHashes.has(r.hash));

  if (newRows.length === 0) {
    return { indexed: 0, unique: seenHashes.size };
  }

  try {
    const result = await db.imageHash.createMany({
      data: newRows,
    });
    return { indexed: result.count, unique: seenHashes.size };
  } catch {
    // Fallback: if createMany fails (e.g. listing/seller not yet committed),
    // try sequential upserts — slower but handles ordering issues
    let indexed = 0;
    for (const row of newRows) {
      try {
        await db.imageHash.upsert({
          where: {
            marketId_listingId_hash: {
              marketId: row.marketId,
              listingId: row.listingId,
              hash: row.hash,
            },
          },
          create: row,
          update: {},
        });
        indexed++;
      } catch {
        // ignore
      }
    }
    return { indexed, unique: seenHashes.size };
  }
}

export interface ImageDuplicateReport {
  hash: string;
  hashType: string;
  sellers: { sellerId: string; username: string; marketId: string }[];
  listings: { listingId: string; title: string; marketId: string }[];
  markets: string[];
  relistCount: number; // same seller relisted
  crossSellerCount: number; // different sellers, same image
  crossMarketCount: number; // different markets, same image
}

/**
 * Find duplicates of a specific image hash across the entire DB.
 * Returns sellers, listings, markets, and the duplicate-type flags.
 */
export async function findHashDuplicates(
  hash: string
): Promise<ImageDuplicateReport | null> {
  const matches = await db.imageHash.findMany({
    where: { hash },
    include: {
      listing: { select: { id: true, title: true, marketId: true } },
      seller: { select: { id: true, username: true, marketId: true } },
    },
  });
  if (matches.length === 0) return null;

  const sellerSet = new Map<string, { sellerId: string; username: string; marketId: string }>();
  const listingSet = new Map<string, { listingId: string; title: string; marketId: string }>();
  const marketSet = new Set<string>();

  for (const m of matches) {
    sellerSet.set(m.sellerId, {
      sellerId: m.seller.id,
      username: m.seller.username,
      marketId: m.seller.marketId,
    });
    listingSet.set(m.listingId, {
      listingId: m.listing.id,
      title: m.listing.title,
      marketId: m.listing.marketId,
    });
    marketSet.add(m.marketId);
  }

  const sellers = Array.from(sellerSet.values());
  const listings = Array.from(listingSet.values());
  const markets = Array.from(marketSet.values());

  // Relist count: any seller who appears on more than one listing with this hash
  const sellerListingCounts = new Map<string, number>();
  for (const m of matches) {
    sellerListingCounts.set(m.sellerId, (sellerListingCounts.get(m.sellerId) ?? 0) + 1);
  }
  const relistCount = Array.from(sellerListingCounts.values()).filter((c) => c > 1).length;

  return {
    hash,
    hashType: matches[0].hashType,
    sellers,
    listings,
    markets,
    relistCount,
    crossSellerCount: sellers.length > 1 ? sellers.length : 0,
    crossMarketCount: markets.length > 1 ? markets.length : 0,
  };
}

/**
 * Top duplicate hashes across the DB — useful for surfacing scam rings.
 *
 * Client-side aggregation (avoids Prisma groupBy having-clause quirks across
 * versions): fetch all rows, group by hash, count distinct sellers/listings/markets.
 */
export async function topDuplicateHashes(limit = 20): Promise<
  Array<{
    hash: string;
    hashType: string;
    sellerCount: number;
    listingCount: number;
    marketCount: number;
  }>
> {
  const all = await db.imageHash.findMany({
    select: {
      hash: true,
      hashType: true,
      sellerId: true,
      listingId: true,
      marketId: true,
    },
  });

  const grouped = new Map<
    string,
    {
      hashType: string;
      sellers: Set<string>;
      listings: Set<string>;
      markets: Set<string>;
    }
  >();

  for (const row of all) {
    let entry = grouped.get(row.hash);
    if (!entry) {
      entry = {
        hashType: row.hashType,
        sellers: new Set(),
        listings: new Set(),
        markets: new Set(),
      };
      grouped.set(row.hash, entry);
    }
    entry.sellers.add(row.sellerId);
    entry.listings.add(row.listingId);
    entry.markets.add(row.marketId);
  }

  const result = Array.from(grouped.entries()).map(([hash, e]) => ({
    hash,
    hashType: e.hashType,
    sellerCount: e.sellers.size,
    listingCount: e.listings.size,
    marketCount: e.markets.size,
  }));

  // Sort by combined scam signal: cross-seller first, then cross-market, then listing count
  result.sort((a, b) => {
    if (b.sellerCount !== a.sellerCount) return b.sellerCount - a.sellerCount;
    if (b.marketCount !== a.marketCount) return b.marketCount - a.marketCount;
    return b.listingCount - a.listingCount;
  });

  return result.slice(0, limit);
}

/**
 * Compute the duplicate count for a specific listing — used as an XGBoost feature.
 * Returns { crossSellerCount, relistCount, crossMarketCount }.
 */
export async function getListingDuplicateSignals(listingId: string): Promise<{
  imageDuplicateCount: number;
  crossSellerCount: number;
  relistCount: number;
  crossMarketCount: number;
}> {
  const hashes = await db.imageHash.findMany({
    where: { listingId },
    select: { hash: true },
  });
  if (hashes.length === 0) {
    return {
      imageDuplicateCount: 0,
      crossSellerCount: 0,
      relistCount: 0,
      crossMarketCount: 0,
    };
  }

  // BATCHED: single query for all hashes (replaces N+1 per-hash findHashDuplicates calls).
  // ~170× faster on 1000+ listings.
  const hashList = hashes.map((h) => h.hash);
  const all = await db.imageHash.findMany({
    where: { hash: { in: hashList } },
    select: {
      hash: true,
      listingId: true,
      sellerId: true,
      marketId: true,
    },
  });

  // Group by hash → compute per-hash stats in memory
  const byHash = new Map<
    string,
    {
      listings: Set<string>;
      sellers: Set<string>;
      markets: Set<string>;
      sellerListingCounts: Map<string, number>;
    }
  >();

  for (const row of all) {
    let entry = byHash.get(row.hash);
    if (!entry) {
      entry = {
        listings: new Set(),
        sellers: new Set(),
        markets: new Set(),
        sellerListingCounts: new Map(),
      };
      byHash.set(row.hash, entry);
    }
    entry.listings.add(row.listingId);
    entry.sellers.add(row.sellerId);
    entry.markets.add(row.marketId);
    entry.sellerListingCounts.set(
      row.sellerId,
      (entry.sellerListingCounts.get(row.sellerId) ?? 0) + 1
    );
  }

  // Aggregate across all hashes for this listing.
  // Use a Set for distinct duplicate listingIds (avoids double-counting
  // when a listing has multiple images that match the same other listing).
  const dupListings = new Set<string>();
  let maxCrossSeller = 0;
  let maxRelist = 0;
  let maxCrossMarket = 0;

  for (const [, entry] of byHash) {
    // Distinct duplicate listings (excluding self)
    for (const lid of entry.listings) {
      if (lid !== listingId) dupListings.add(lid);
    }
    maxCrossSeller = Math.max(maxCrossSeller, entry.sellers.size);
    maxCrossMarket = Math.max(maxCrossMarket, entry.markets.size);
    // Relist = any seller appearing on >1 listing with this hash
    for (const count of entry.sellerListingCounts.values()) {
      if (count > 1) maxRelist = Math.max(maxRelist, 1);
    }
  }

  return {
    imageDuplicateCount: dupListings.size,
    crossSellerCount: maxCrossSeller,
    relistCount: maxRelist,
    crossMarketCount: maxCrossMarket,
  };
}
