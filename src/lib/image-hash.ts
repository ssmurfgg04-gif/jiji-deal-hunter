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
  let indexed = 0;
  const seenHashes = new Set<string>();

  for (const url of imageUrls) {
    const extracted = extractImageHash(url);
    if (!extracted) continue;
    if (seenHashes.has(extracted.hash)) continue;
    seenHashes.add(extracted.hash);

    try {
      await db.imageHash.upsert({
        where: {
          marketId_listingId_hash: { marketId, listingId, hash: extracted.hash },
        },
        create: {
          marketId,
          listingId,
          sellerId,
          hash: extracted.hash,
          hashType: extracted.hashType,
          url,
        },
        update: {
          // already indexed — no-op
        },
      });
      indexed++;
    } catch {
      // ignore individual failures (e.g. seller/listing not yet committed)
    }
  }
  return { indexed, unique: seenHashes.size };
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
  // Group by hash, count distinct sellers, listings, markets
  const rows = await db.imageHash.groupBy({
    by: ["hash", "hashType"],
    _count: {
      sellerId: true,
      listingId: true,
      marketId: true,
    },
    orderBy: {
      _count: {
        listingId: "desc",
      },
    },
    take: limit,
  });
  // Prisma groupBy with distinct counts is limited; do it client-side for accuracy
  const result = [];
  for (const row of rows) {
    const distinct = await db.imageHash.findMany({
      where: { hash: row.hash },
      select: { sellerId: true, listingId: true, marketId: true },
    });
    const sellerSet = new Set(distinct.map((d) => d.sellerId));
    const listingSet = new Set(distinct.map((d) => d.listingId));
    const marketSet = new Set(distinct.map((d) => d.marketId));
    result.push({
      hash: row.hash,
      hashType: row.hashType,
      sellerCount: sellerSet.size,
      listingCount: listingSet.size,
      marketCount: marketSet.size,
    });
  }
  // Sort by combined scam signal: cross-seller first, then cross-market
  result.sort((a, b) => {
    if (b.sellerCount !== a.sellerCount) return b.sellerCount - a.sellerCount;
    return b.marketCount - a.marketCount;
  });
  return result;
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

  let totalDuplicates = 0;
  let maxCrossSeller = 0;
  let maxRelist = 0;
  let maxCrossMarket = 0;

  for (const { hash } of hashes) {
    const dup = await findHashDuplicates(hash);
    if (!dup) continue;
    totalDuplicates += dup.listings.length - 1; // exclude self
    maxCrossSeller = Math.max(maxCrossSeller, dup.crossSellerCount);
    maxRelist = Math.max(maxRelist, dup.relistCount);
    maxCrossMarket = Math.max(maxCrossMarket, dup.crossMarketCount);
  }

  return {
    imageDuplicateCount: totalDuplicates,
    crossSellerCount: maxCrossSeller,
    relistCount: maxRelist,
    crossMarketCount: maxCrossMarket,
  };
}
