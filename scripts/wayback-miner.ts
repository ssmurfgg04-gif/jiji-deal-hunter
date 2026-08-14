#!/usr/bin/env bun
/**
 * Jiji Wayback Miner
 *
 * Mines the full Wayback Machine /api_web/v1/{item,listing} corpus and
 * loads the rows into SQLite via Prisma. Passive archival mining only —
 * never touches jiji.co.ke directly.
 *
 * Source: ~135 full-feature item captures + ~35 listing captures (~700 ad rows)
 * Target: 800+ real archived listings as XGBoost training data.
 *
 * Usage: bun scripts/wayback-miner.ts
 *
 * Idempotent: re-running skips rows already in the DB.
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";

const db = new PrismaClient();

const CDX = "https://web.archive.org/cdx/search/cdx";
const RAW = "https://web.archive.org/web/{ts}id_/{url}";
const UA = "Mozilla/5.0 (X11; Linux x86_64) research-archive-miner/1.0";

const MARKET_ID = "ke" as const;
const MARKET_BASE = "https://jiji.co.ke";

interface RawRow {
  guid: string;
  title: string;
  price: number | null;
  date_created: string | null;
  date_moderated: string | null;
  date_edited: string | null;
  seller_id: number | null;
  seller_name: string;
  phone: string;
  category_id: number | null;
  category_name: string;
  count_views: number | null;
  fav_count: number | null;
  adverts_count: number | null;
  feedback_count: number | null;
  rating: number | null;
  boost_badge: string;
  capture_ts: string;
  image_urls: string;
  source: string; // "item" | "listing"
}

function httpGet(url: string, tries = 3): string | null {
  for (let i = 0; i < tries; i++) {
    try {
      // Bun's fetch is sync-friendly enough for our purposes
      const resp = fetch(url, {
        headers: { "User-Agent": UA },
        // @ts-ignore — Bun supports sync flag on fetch in scripts
        sync: true,
      } as any);
      if (resp.ok) return resp.text();
      if (resp.status === 404) return null;
    } catch (e: any) {
      if (i === tries - 1) return null;
    }
    // sleep
    const sleepMs = 2000 + i * 3000;
    const start = Date.now();
    while (Date.now() - start < sleepMs) {
      // busy-wait (sync)
    }
  }
  return null;
}

function cdxList(prefix: string): Array<{ ts: string; orig: string }> {
  const q = `${CDX}?url=jiji.co.ke/${prefix}&matchType=prefix&filter=statuscode:200&collapse=urlkey&fl=timestamp,original&output=json&limit=3000`;
  const data = httpGet(q);
  if (!data) return [];
  try {
    const rows = JSON.parse(data) as any[];
    if (rows.length < 2) return [];
    return rows.slice(1).map((r) => ({ ts: r[0], orig: r[1] }));
  } catch {
    return [];
  }
}

function extractItem(j: any, ts: string): RawRow | null {
  const adv = j?.advert ?? {};
  const s = j?.seller ?? {};
  const imgs: string[] = [];
  for (const im of adv?.images ?? []) {
    if (im?.url) imgs.push(im.url);
  }
  if (imgs.length === 0 && j?.seo?.og_image_list) {
    for (const row of j.seo.og_image_list) {
      if (Array.isArray(row) && row[0] === "image" && row[1]) {
        imgs.push(row[1]);
      }
    }
  }
  const guid =
    j?.seo?.web_url?.replace(/\/$/, "").split("/").pop() ??
    adv?.guid ??
    adv?.id ??
    null;
  if (!guid) return null;
  return {
    guid: String(guid),
    title: adv?.title ?? "",
    price: s?.advert_price ?? adv?.price_obj?.price ?? null,
    date_created: adv?.date_created ?? null,
    date_moderated: adv?.date_moderated ?? null,
    date_edited: adv?.date_edited ?? null,
    seller_id: s?.id ?? null,
    seller_name: s?.name ?? "",
    phone: s?.phone ? String(s.phone) : "",
    category_id: adv?.category_id ?? null,
    category_name: adv?.category_name ?? "",
    count_views: adv?.count_views ?? null,
    fav_count: adv?.fav_count ?? null,
    adverts_count: s?.adverts_count ?? null,
    feedback_count: s?.feedback_count ?? null,
    rating: s?.rating ?? null,
    boost_badge: adv?.badge_info?.label ?? "",
    capture_ts: ts,
    image_urls: imgs.join(";"),
    source: "item",
  };
}

function extractListing(j: any, ts: string): RawRow[] {
  const rows: RawRow[] = [];
  const ads = j?.adverts_list?.adverts ?? j?.adverts ?? [];
  for (const ad of ads) {
    const imgs: string[] = [];
    for (const im of ad?.images ?? []) {
      if (im?.url) imgs.push(im.url);
    }
    const guid = ad?.guid ?? ad?.id ?? null;
    if (!guid) continue;
    rows.push({
      guid: String(guid),
      title: ad?.title ?? "",
      price: ad?.price_obj?.price ?? ad?.price_obj?.value ?? null,
      date_created: null,
      date_moderated: null,
      date_edited: null,
      seller_id: ad?.user_id ?? null,
      seller_name: "",
      phone: ad?.user_phone ? String(ad.user_phone) : "",
      category_id: ad?.category_id ?? null,
      category_name: "",
      count_views: null,
      fav_count: null,
      adverts_count: null,
      feedback_count: null,
      rating: null,
      boost_badge: ad?.badge_info?.label ?? "",
      capture_ts: ts,
      image_urls: imgs.join(";"),
      source: "listing",
    });
  }
  return rows;
}

function parseDateOrNull(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function ensureMarket() {
  await db.market.upsert({
    where: { id: MARKET_ID },
    create: { id: MARKET_ID, name: "Kenya", baseUrl: MARKET_BASE, lastCensusAt: new Date() },
    update: {},
  });
}

async function persistRow(row: RawRow): Promise<{ inserted: boolean }> {
  if (!row.guid || !row.seller_id) return { inserted: false };

  const sellerId = `${MARKET_ID}-${row.seller_id}`;
  const listingId = `${MARKET_ID}-${row.guid}`;

  // Upsert seller
  const hidePhone = false; // archived listings don't carry this flag
  const phoneLeaked = hidePhone && !!row.phone;
  await db.seller.upsert({
    where: { id: sellerId },
    create: {
      id: sellerId,
      marketId: MARKET_ID,
      numericUserId: row.seller_id,
      username: row.seller_name || `seller-${row.seller_id}`,
      accountAgeDays: 0,
      totalListings: row.adverts_count ?? 0,
      advertsCount: row.adverts_count ?? 0,
      feedbackCount: row.feedback_count ?? 0,
      rating: row.rating ?? 0,
      hidePhone,
      phoneLeaked,
      phone: row.phone || null,
      verifiedBadge: false,
    },
    update: {
      advertsCount: row.adverts_count ?? undefined,
      feedbackCount: row.feedback_count ?? undefined,
      rating: row.rating ?? undefined,
      phone: row.phone || undefined,
    },
  });

  // Upsert listing
  const existing = await db.listing.findUnique({ where: { id: listingId } });
  if (existing) return { inserted: false };

  const imageUrls = row.image_urls ? row.image_urls.split(";").filter(Boolean) : [];
  await db.listing.create({
    data: {
      id: listingId,
      marketId: MARKET_ID,
      guid: row.guid,
      title: row.title || "Untitled",
      price: row.price ?? 0,
      currency: "KES",
      category: row.category_name || "uncategorized",
      categoryId: row.category_id,
      condition: "unknown",
      imageUrl: imageUrls[0] ?? null,
      imageCount: imageUrls.length,
      views: row.count_views ?? 0,
      favCount: row.fav_count ?? 0,
      daysOnMarket: 0,
      url: `${MARKET_BASE}/item/${row.guid}`,
      status: "active",
      dateCreated: parseDateOrNull(row.date_created),
      dateEdited: parseDateOrNull(row.date_edited),
      dateModerated: parseDateOrNull(row.date_moderated),
      sellerId,
    },
  });

  // Index image hashes for the new listing
  if (imageUrls.length > 0) {
    for (const url of imageUrls) {
      const hash = extractImageHashSimple(url);
      if (!hash) continue;
      try {
        await db.imageHash.upsert({
          where: {
            marketId_listingId_hash: {
              marketId: MARKET_ID,
              listingId,
              hash: hash.hash,
            },
          },
          create: {
            marketId: MARKET_ID,
            listingId,
            sellerId,
            hash: hash.hash,
            hashType: hash.hashType,
            url,
          },
          update: {},
        });
      } catch {
        // ignore individual failures
      }
    }
  }

  return { inserted: true };
}

function extractImageHashSimple(url: string): { hash: string; hashType: "modern" | "legacy" } | null {
  // Modern: {id}_{b64("W-H-hash")}.webp
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
  // Legacy: {id}_{filename}_{W}x{H}.jpg
  const legacyMatch = url.match(/(\d+)_(.+?)_(\d+)x(\d+)\.(?:jpg|jpeg|png)$/);
  if (legacyMatch) {
    const [, id, filename] = legacyMatch;
    return { hash: `legacy:${id}:${filename}`, hashType: "legacy" };
  }
  return null;
}

async function main() {
  await ensureMarket();
  console.log("[wayback] Starting Wayback mining...");

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const prefix of ["api_web/v1/item", "api_web/v1/listing"]) {
    console.log(`[wayback] CDX enumeration: ${prefix}`);
    const captures = cdxList(prefix);
    console.log(`[wayback] Found ${captures.length} captures for ${prefix}`);

    for (const { ts, orig } of captures) {
      const url = RAW.replace("{ts}", ts).replace("{url}", orig);
      const body = httpGet(url);
      if (!body) {
        totalFailed++;
        continue;
      }
      let j: any = null;
      try {
        j = JSON.parse(body);
      } catch {
        totalFailed++;
        continue;
      }
      const rows: RawRow[] =
        prefix.includes("item") ? (extractItem(j, ts) ? [extractItem(j, ts)!] : []) : extractListing(j, ts);

      for (const row of rows) {
        try {
          const { inserted } = await persistRow(row);
          if (inserted) totalInserted++;
          else totalSkipped++;
        } catch (e: any) {
          totalFailed++;
        }
      }
      // 0.7s pacing between Wayback requests
      const sleepUntil = Date.now() + 700;
      while (Date.now() < sleepUntil) {
        // busy-wait (sync fetch context)
      }
    }
  }

  console.log(
    `[wayback] Done. Inserted: ${totalInserted}, Skipped (already in DB): ${totalSkipped}, Failed: ${totalFailed}`
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[wayback] FATAL:", e);
  process.exit(1);
});
