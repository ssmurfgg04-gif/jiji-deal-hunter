#!/usr/bin/env bun
/**
 * Import the real Wayback dataset into the DB.
 *
 * Source: https://github.com/ssmurfgg04-gif/jiji-wayback-dataset
 * File:   scripts/jiji-wayback-listings.csv (3,947 real archived rows)
 *
 * Composition per the dataset README:
 *   - 774 full item rows (all fields populated incl. dates, views, seller stats)
 *   - 3,173 lean listing rows (title, price, seller_id, category, badge)
 *   - 1,549 Kenya (ke) · 2,341 Nigeria (ng) · 57 Tanzania (tz)
 *   - 3,024 unique guids · 1,369 unique sellers
 *   - 3,213 rows with phone · 2,787 with image URLs · 1,243 with boost badges
 *
 * Multi-market: ke (KES), ng (NGN), tz (TZS).
 *
 * Idempotent: re-running skips listings already in DB (matched by marketId+guid).
 *
 * Usage: bun scripts/import-wayback-dataset.ts
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const db = new PrismaClient();

interface RawRow {
  guid: string;
  title: string;
  price: string;
  date_created: string;
  date_moderated: string;
  date_edited: string;
  seller_id: string;
  seller_name: string;
  phone: string;
  category_id: string;
  category_name: string;
  count_views: string;
  fav_count: string;
  adverts_count: string;
  feedback_count: string;
  rating: string;
  boost_badge: string;
  capture_ts: string;
  image_urls: string;
  source: string;
  country: string;
}

const MARKET_CURRENCIES: Record<string, string> = {
  ke: "KES",
  ng: "NGN",
  tz: "TZS",
  ug: "UGX",
  gh: "GHS",
};

const MARKET_BASES: Record<string, string> = {
  ke: "https://jiji.co.ke",
  ng: "https://jiji.ng",
  tz: "https://jiji.co.tz",
  ug: "https://jiji.ug",
  gh: "https://jiji.com.gh",
};

function num(s: string | null | undefined, fallback = 0): number {
  if (!s) return fallback;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return isNaN(n) ? fallback : n;
}

function float(s: string | null | undefined, fallback = 0): number {
  if (!s) return fallback;
  const n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isNaN(n) ? fallback : n;
}

function dateOrNull(s: string | null | undefined): Date | null {
  if (!s) return null;
  // Wayback capture_ts is YYYYMMDDhhmmss
  if (/^\d{14}$/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10);
    const mo = parseInt(s.slice(4, 6), 10) - 1;
    const d = parseInt(s.slice(6, 8), 10);
    const h = parseInt(s.slice(8, 10), 10);
    const mi = parseInt(s.slice(10, 12), 10);
    const se = parseInt(s.slice(12, 14), 10);
    const dt = new Date(Date.UTC(y, mo, d, h, mi, se));
    return isNaN(dt.getTime()) ? null : dt;
  }
  // RFC-1123 format: "Sat, 28 Mar 2020 07:24:48 GMT"
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

function extractImageHash(url: string): { hash: string; hashType: "modern" | "legacy" } | null {
  const modernMatch = url.match(/_([A-Za-z0-9+/\-_]+)\.(?:webp|jpg|jpeg|png)$/);
  if (modernMatch) {
    try {
      const b64 = modernMatch[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "===".slice((b64.length + 3) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf-8");
      const parts = decoded.split("-");
      if (parts.length >= 3) {
        const hash = parts[parts.length - 1];
        if (/^[a-f0-9]{6,20}$/i.test(hash)) {
          return { hash: hash.toLowerCase(), hashType: "modern" };
        }
      }
    } catch {
      // fall through
    }
  }
  const legacyMatch = url.match(/(\d+)_(.+?)_(\d+)x(\d+)\.(?:jpg|jpeg|png)$/);
  if (legacyMatch) {
    const [, id, filename] = legacyMatch;
    return { hash: `legacy:${id}:${filename}`, hashType: "legacy" };
  }
  return null;
}

async function main() {
  const csvPath = path.resolve(__dirname, "jiji-wayback-listings.csv");
  console.log(`[import] Reading ${csvPath}...`);

  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const lines = csvContent.split("\n").filter((l) => l.trim());
  const headers = lines[0].split(",");
  console.log(`[import] ${lines.length - 1} rows, ${headers.length} columns`);

  // Simple CSV parser (handles quoted fields with commas)
  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // Parse all rows
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < headers.length) continue;
    const row: any = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (fields[j] ?? "").trim();
    }
    rows.push(row);
  }
  console.log(`[import] Parsed ${rows.length} rows`);

  // Ensure all markets exist
  for (const [marketId, baseUrl] of Object.entries(MARKET_BASES)) {
    await db.market.upsert({
      where: { id: marketId },
      create: {
        id: marketId,
        name: { ke: "Kenya", ng: "Nigeria", tz: "Tanzania", ug: "Uganda", gh: "Ghana" }[marketId] ?? marketId,
        baseUrl,
        lastCensusAt: new Date(),
      },
      update: {},
    });
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let sellersUpserted = 0;
  let imageHashesIndexed = 0;

  // Pre-fetch existing listing IDs to skip quickly
  console.log("[import] Pre-fetching existing listing IDs...");
  const existingListingIds = new Set(
    (await db.listing.findMany({ select: { id: true } })).map((l) => l.id)
  );
  console.log(`[import] ${existingListingIds.size} listings already in DB`);

  // Batch seller upserts to avoid N+1
  const sellerCache = new Set<string>(await db.seller.findMany({ select: { id: true } }).then((s) => s.map((x) => x.id)));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const marketId = (row.country || "ke").toLowerCase();
      if (!MARKET_CURRENCIES[marketId]) {
        skipped++;
        continue;
      }

      const guid = row.guid;
      if (!guid) {
        skipped++;
        continue;
      }

      const listingId = `${marketId}-${guid}`;
      if (existingListingIds.has(listingId)) {
        skipped++;
        continue;
      }

      const numericSellerId = num(row.seller_id, 0);
      if (numericSellerId === 0) {
        skipped++;
        continue;
      }

      const sellerId = `${marketId}-${numericSellerId}`;
      const phone = row.phone?.trim() || null;
      const hidePhone = false;
      const phoneLeaked = false;
      const advertsCount = num(row.adverts_count, 0);
      const feedbackCount = num(row.feedback_count, 0);
      const rating = float(row.rating, 0);
      const isDealer = advertsCount > 0 && advertsCount / Math.max(feedbackCount, 1) > 50;

      // Upsert seller if not in cache
      if (!sellerCache.has(sellerId)) {
        await db.seller.upsert({
          where: { id: sellerId },
          create: {
            id: sellerId,
            marketId,
            numericUserId: numericSellerId,
            username: row.seller_name?.trim() || `seller-${numericSellerId}`,
            accountAgeDays: 0,
            totalListings: advertsCount,
            advertsCount,
            feedbackCount,
            rating,
            hidePhone,
            phoneLeaked,
            phone,
            verifiedBadge: false,
            isDealer,
          },
          update: {
            advertsCount: advertsCount || undefined,
            feedbackCount: feedbackCount || undefined,
            rating: rating || undefined,
            phone: phone || undefined,
            isDealer,
          },
        });
        sellerCache.add(sellerId);
        sellersUpserted++;
      }

      const imageUrls = row.image_urls ? row.image_urls.split(";").filter(Boolean) : [];
      const category = row.category_name?.trim() || "uncategorized";
      const price = num(row.price, 0);
      const currency = MARKET_CURRENCIES[marketId];
      const boostBadge = row.boost_badge?.trim() || "";
      const isBoost = !!boostBadge;

      // Compute days on market from date_created
      const dateCreated = dateOrNull(row.date_created);
      let daysOnMarket = 0;
      if (dateCreated) {
        daysOnMarket = Math.max(0, Math.floor((Date.now() - dateCreated.getTime()) / 86400000));
      }

      await db.listing.create({
        data: {
          id: listingId,
          marketId,
          guid,
          title: row.title?.trim() || "Untitled",
          price: BigInt(price),
          currency,
          category,
          categoryId: num(row.category_id, 0) || null,
          condition: "unknown",
          location: null,
          imageUrl: imageUrls[0] ?? null,
          imageCount: imageUrls.length,
          views: num(row.count_views, 0),
          favCount: num(row.fav_count, 0),
          daysOnMarket,
          url: `${MARKET_BASES[marketId]}/item/${guid}`,
          status: "active",
          dateCreated,
          dateEdited: dateOrNull(row.date_edited),
          dateModerated: dateOrNull(row.date_moderated),
          isBoost,
          sellerId,
          priceHistory: price > 0 ? {
            create: [{ price: BigInt(price), recordedAt: dateOrNull(row.capture_ts) ?? new Date() }],
          } : undefined,
        },
      });
      existingListingIds.add(listingId);
      inserted++;

      // Index image hashes (batched — see indexListingImages optimization)
      if (imageUrls.length > 0) {
        for (const url of imageUrls) {
          const hash = extractImageHash(url);
          if (!hash) continue;
          try {
            await db.imageHash.upsert({
              where: {
                marketId_listingId_hash: {
                  marketId,
                  listingId,
                  hash: hash.hash,
                },
              },
              create: {
                marketId,
                listingId,
                sellerId,
                hash: hash.hash,
                hashType: hash.hashType,
                url,
              },
              update: {},
            });
            imageHashesIndexed++;
          } catch {
            // ignore individual failures
          }
        }
      }

      if ((i + 1) % 500 === 0) {
        console.log(`[import] Progress: ${i + 1}/${rows.length} (inserted: ${inserted}, skipped: ${skipped}, hashes: ${imageHashesIndexed})`);
      }
    } catch (e: any) {
      failed++;
      if (failed < 5) {
        console.error(`[import] Failed row ${i}: ${e?.message ?? "unknown"}`);
      }
    }
  }

  console.log("");
  console.log(`[import] Done.`);
  console.log(`  Inserted:        ${inserted}`);
  console.log(`  Skipped:         ${skipped}`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Sellers upserted: ${sellersUpserted}`);
  console.log(`  Image hashes:    ${imageHashesIndexed}`);

  // Final DB counts
  const totalListings = await db.listing.count();
  const totalSellers = await db.seller.count();
  const totalHashes = await db.imageHash.count();
  const byMarket = await db.listing.groupBy({ by: ["marketId"], _count: { id: true } });
  console.log("");
  console.log(`DB now contains:`);
  console.log(`  ${totalListings} listings`);
  console.log(`  ${totalSellers} sellers`);
  console.log(`  ${totalHashes} image hashes`);
  console.log(`  By market:`);
  for (const m of byMarket) {
    console.log(`    ${m.marketId}: ${m._count.id}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[import] FATAL:", e);
  process.exit(1);
});
