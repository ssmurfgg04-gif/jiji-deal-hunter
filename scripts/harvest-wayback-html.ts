#!/usr/bin/env bun
/**
 * Wayback HTML card harvester.
 *
 * Mines category-page captures from web.archive.org and extracts
 * (item_id, price, timestamp) tuples from the HTML advert cards.
 *
 * This gives us the TEMPORAL layer that the API-only dataset lacks:
 *   - Multiple captures of the same item at different timestamps
 *   - Enables price_delta, days_listed, views_velocity computation
 *   - Enables the non-leaking "motivated seller" target
 *
 * Strategy:
 *   1. CDX query for jiji.co.ke/category/* pages (all captures)
 *   2. For each capture, fetch the raw HTML from Wayback
 *   3. Parse with linkedom (lightweight DOM parser)
 *   4. Extract advert cards: item_id from href, price from text
 *   5. Store as PriceSnapshot rows
 *
 * Passive: only touches web.archive.org, never jiji.co.ke.
 * Idempotent: skips (marketId, itemId, captureTimestamp) already in DB.
 *
 * Usage: bun scripts/harvest-wayback-html.ts
 *
 * NOTE: Requires internet access to web.archive.org. The sandbox cannot
 * reach it, so run this on your local machine. The script handles the
 * CDX enumeration + HTML parsing logic; you just need to run it where
 * archive.org is reachable.
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";

const db = new PrismaClient();

const CDX = "https://web.archive.org/cdx/search/cdx";
const RAW = "https://web.archive.org/web/{ts}id_/{url}";
const UA = "Mozilla/5.0 (X11; Linux x86_64) research-archive-miner/1.0";
const REQUEST_DELAY_MS = 700;

// Markets to harvest (from the wayback-dataset repo, ke/ng/tz are present)
const MARKETS = [
  { id: "ke", base: "jiji.co.ke", currency: "KES" },
  { id: "ng", base: "jiji.ng", currency: "NGN" },
  { id: "tz", base: "jiji.co.tz", currency: "TZS" },
] as const;

interface CdxRow {
  ts: string;
  orig: string;
}

interface ParsedCard {
  itemId: string;
  price: bigint;
  title: string;
}

/**
 * Fetch with retries + polite delay.
 */
async function httpGet(url: string, tries = 3): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        if (resp.status === 404) return null;
        if (i < tries - 1) {
          await sleep(REQUEST_DELAY_MS * (i + 2));
          continue;
        }
        return null;
      }
      return await resp.text();
    } catch {
      if (i < tries - 1) {
        await sleep(REQUEST_DELAY_MS * (i + 2));
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * CDX enumeration for category-page captures.
 * Returns all (timestamp, original-url) pairs for category/* pages.
 */
async function cdxList(marketBase: string): Promise<CdxRow[]> {
  const q = `${CDX}?url=${marketBase}/category/*&matchType=prefix&filter=statuscode:200&collapse=urlkey&fl=timestamp,original&output=json&limit=5000`;
  const data = await httpGet(q);
  if (!data) return [];
  try {
    const rows = JSON.parse(data) as any[];
    if (rows.length < 2) return [];
    return rows.slice(1).map((r) => ({ ts: r[0], orig: r[1] }));
  } catch {
    return [];
  }
}

/**
 * Parse an HTML category page and extract advert cards.
 *
 * Jiji category pages have advert cards with:
 *   <a href="/item/{guid}" class="b-list-advert-base-item__link">
 *     <div class="b-list-advert-base-item__price">KSh 50,000</div>
 *     <div class="b-list-advert-base-item__title">iPhone 14 Pro</div>
 *   </a>
 *
 * The exact class names vary by era (2020 vs 2022 vs 2024), so we use
 * a fuzzy approach: find all <a> tags whose href matches /item/ or
 * /advert/, then look for a price-like text nearby.
 */
function parseHtmlCards(html: string, marketId: string): ParsedCard[] {
  const cards: ParsedCard[] = [];

  // Extract all item links with their surrounding context
  // Regex handles both /item/{guid} and /advert/{id} URL patterns
  // and captures the price text that appears nearby.
  const linkRegex = /href=["'](?:https?:\/\/[^"']*)?\/(?:item|advert)\/([A-Za-z0-9_-]+)["'][^>]*>([\s\S]*?)(?=<a\s|<\/div>\s*<a|<a\s)/gi;

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const itemId = match[1];
    const cardHtml = match[2];

    // Skip if itemId looks like a slug (contains hyphens and is very long)
    if (itemId.length > 50 || itemId.includes("--")) continue;

    // Extract price from the card HTML
    // Matches: KSh 50,000 | KSh 50000 | KSh 50K | TSh 1,200,000 | ₦45,000
    const priceMatch = cardHtml.match(/(?:KSh|TSh|UGX|GHS|₦)\s*([\d,.]+[KkMm]?)/i);
    if (!priceMatch) continue;

    const price = parsePriceText(priceMatch[0], marketId);
    if (price === null || price <= BigInt(0)) continue;

    // Extract title (first non-price text block)
    const titleMatch = cardHtml.match(/<[^>]+class="[^"]*title[^"]*"[^>]*>([^<]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    cards.push({ itemId, price, title });
  }

  return cards;
}

/**
 * Parse price text like "KSh 50,000" or "KSh 50K" into BigInt.
 */
function parsePriceText(text: string, marketId: string): bigint | null {
  // Strip currency prefix
  const cleaned = text.replace(/KSh|TSh|UGX|GHS|₦/gi, "").trim();

  // Handle K (thousands) and M (millions) suffixes
  const m = cleaned.match(/([\d,.]+)\s*([KkMm])?/);
  if (!m) return null;

  const numStr = m[1].replace(/,/g, "");
  const num = parseFloat(numStr);
  if (isNaN(num)) return null;

  const suffix = m[2]?.toLowerCase();
  let multiplier = 1;
  if (suffix === "k") multiplier = 1000;
  else if (suffix === "m") multiplier = 1_000_000;

  return BigInt(Math.round(num * multiplier));
}

/**
 * Parse a Wayback capture timestamp (YYYYMMDDhhmmss) into a Date.
 */
function parseCaptureTs(ts: string): Date {
  const y = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10) - 1;
  const d = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10), 10);
  const mi = parseInt(ts.slice(10, 12), 10);
  const se = parseInt(ts.slice(12, 14), 10);
  return new Date(Date.UTC(y, mo, d, h, mi, se));
}

async function main() {
  console.log("[harvest] Starting Wayback HTML card harvest...");

  let totalExtracts = 0;
  let totalCaptures = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const market of MARKETS) {
    console.log(`\n[harvest] Market: ${market.id} (${market.base})`);

    // 1. CDX enumerate category-page captures
    const captures = await cdxList(market.base);
    console.log(`[harvest] Found ${captures.length} category-page captures for ${market.id}`);

    if (captures.length === 0) {
      console.log(`[harvest] No captures for ${market.id} — skipping (run on your machine if archive.org is unreachable)`);
      continue;
    }

    // 2. Fetch + parse each capture
    for (let i = 0; i < captures.length; i++) {
      const { ts, orig } = captures[i];
      const captureTimestamp = parseCaptureTs(ts);
      const captureUrl = RAW.replace("{ts}", ts).replace("{url}", orig);

      const html = await httpGet(captureUrl);
      if (!html) {
        totalFailed++;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      totalCaptures++;

      // 3. Parse advert cards from HTML
      const cards = parseHtmlCards(html, market.id);

      // 4. Store each card as a PriceSnapshot row
      let captureExtracts = 0;
      for (const card of cards) {
        try {
          await db.priceSnapshot.upsert({
            where: {
              marketId_itemId_captureTimestamp: {
                marketId: market.id,
                itemId: card.itemId,
                captureTimestamp,
              },
            },
            create: {
              marketId: market.id,
              itemId: card.itemId,
              price: card.price,
              currency: market.currency,
              categorySlug: orig.split("/category/")[1]?.split("?")[0] ?? null,
              captureTimestamp,
              captureUrl: orig,
              pageTitle: card.title,
            },
            update: {},
          });
          captureExtracts++;
          totalExtracts++;
        } catch {
          totalSkipped++;
        }
      }

      if (captureExtracts > 0) {
        console.log(`[harvest] [${market.id}] capture ${i + 1}/${captures.length} (${ts}): ${captureExtracts} cards extracted`);
      }

      // Polite delay between captures
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`\n[harvest] Done.`);
  console.log(`  Captures fetched: ${totalCaptures}`);
  console.log(`  Extracts stored:  ${totalExtracts}`);
  console.log(`  Skipped:          ${totalSkipped}`);
  console.log(`  Failed:           ${totalFailed}`);

  // Report items with multiple captures (the temporal signal)
  const multiCapture = await db.priceSnapshot.groupBy({
    by: ["marketId", "itemId"],
    _count: { captureTimestamp: true },
    having: { captureTimestamp: { _count: { gt: 1 } } },
    orderBy: { marketId: "asc" },
    take: 5,
  });
  console.log(`\n  Items with multiple captures (temporal signal): ${multiCapture.length}+`);
  for (const m of multiCapture.slice(0, 5)) {
    console.log(`    ${m.marketId}/${m.itemId}: ${m._count.captureTimestamp} captures`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[harvest] FATAL:", e);
  process.exit(1);
});
