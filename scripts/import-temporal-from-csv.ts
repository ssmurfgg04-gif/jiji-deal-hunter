#!/usr/bin/env bun
/**
 * Import temporal data from the existing wayback-dataset CSV into
 * the WaybackHtmlExtract table.
 *
 * The CSV at scripts/jiji-wayback-listings.csv has 3,947 rows with
 * `capture_ts` timestamps. 595 GUIDs have multiple captures — that's
 * the temporal signal we need for the non-leaking motivated_seller target.
 *
 * This script extracts (marketId, itemId, price, captureTimestamp) tuples
 * from the CSV into WaybackHtmlExtract rows, which the resolve-entities
 * script then collapses into CanonicalItem records with price time series.
 *
 * Usage: bun scripts/import-temporal-from-csv.ts
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const db = new PrismaClient();

const MARKET_CURRENCIES: Record<string, string> = {
  ke: "KES",
  ng: "NGN",
  tz: "TZS",
};

interface RawRow {
  guid: string;
  title: string;
  price: string;
  capture_ts: string;
  category_name: string;
  country: string;
  source: string;
}

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

function parseCaptureTs(ts: string): Date | null {
  if (!ts || !/^\d{14}$/.test(ts)) return null;
  const y = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10) - 1;
  const d = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10), 10);
  const mi = parseInt(ts.slice(10, 12), 10);
  const se = parseInt(ts.slice(12, 14), 10);
  const dt = new Date(Date.UTC(y, mo, d, h, mi, se));
  return isNaN(dt.getTime()) ? null : dt;
}

async function main() {
  const csvPath = path.resolve(__dirname, "jiji-wayback-listings.csv");
  console.log(`[temporal] Reading ${csvPath}...`);

  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const lines = csvContent.split("\n").filter((l) => l.trim());
  // Strip carriage returns (CSV has Windows CRLF line endings)
  const cleanLines = lines.map((l) => l.replace(/\r$/, ""));
  const headers = parseCsvLine(cleanLines[0]).map((h: string) => h.trim());

  const rows: RawRow[] = [];
  for (let i = 1; i < cleanLines.length; i++) {
    const fields = parseCsvLine(cleanLines[i]);
    if (fields.length < headers.length) continue;
    const row: any = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (fields[j] ?? "").trim();
    }
    rows.push(row);
  }
  console.log(`[temporal] Parsed ${rows.length} rows`);

  // Group by (country, guid) to find items with multiple captures
  const byItem = new Map<string, RawRow[]>();
  for (const row of rows) {
    if (!row.guid || !row.capture_ts) continue;
    const key = `${row.country}-${row.guid}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key)!.push(row);
  }
  console.log(`[temporal] ${byItem.size} unique (country, guid) pairs`);

  let multiCapture = 0;
  for (const [, captures] of byItem) {
    if (captures.length > 1) multiCapture++;
  }
  console.log(`[temporal] ${multiCapture} items with multiple captures (temporal signal)`);

  // Insert into WaybackHtmlExtract
  let inserted = 0;
  let skipped = 0;

  for (const [key, captures] of byItem) {
    // Key format: `${country}-${guid}` where country is 2 chars (ke/ng/tz)
    // and guid may contain hyphens, so split only on the first hyphen
    const dashIdx = key.indexOf("-");
    const marketId = key.slice(0, dashIdx);
    const itemId = key.slice(dashIdx + 1);
    if (!MARKET_CURRENCIES[marketId]) continue;

    for (const row of captures) {
      const captureTimestamp = parseCaptureTs(row.capture_ts);
      if (!captureTimestamp) continue;

      const price = parseInt(row.price?.replace(/[^\d]/g, "") || "0", 10);
      if (price <= 0) continue;

      try {
        await db.waybackHtmlExtract.upsert({
          where: {
            marketId_itemId_captureTimestamp: {
              marketId,
              itemId,
              captureTimestamp,
            },
          },
          create: {
            marketId,
            itemId,
            price: BigInt(price),
            currency: MARKET_CURRENCIES[marketId],
            categorySlug: row.category_name?.toLowerCase().replace(/\s+/g, "-") ?? null,
            captureTimestamp,
            captureUrl: `https://web.archive.org/web/${row.capture_ts}/https://jiji.${marketId === "ke" ? "co.ke" : marketId === "ng" ? "ng" : "co.tz"}/api_web/v1/${row.source}`,
            pageTitle: row.title,
          },
          update: {},
        });
        inserted++;
      } catch {
        skipped++;
      }
    }
  }

  console.log(`\n[temporal] Done. Inserted: ${inserted}, Skipped: ${skipped}`);

  // Verify
  const total = await db.waybackHtmlExtract.count();
  const multiCaptureItems = await db.waybackHtmlExtract.groupBy({
    by: ["marketId", "itemId"],
    _count: { captureTimestamp: true },
    having: { captureTimestamp: { _count: { gt: 1 } } },
  });
  console.log(`[temporal] DB now has ${total} extracts, ${multiCaptureItems.length} items with multiple captures`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[temporal] FATAL:", e);
  process.exit(1);
});
