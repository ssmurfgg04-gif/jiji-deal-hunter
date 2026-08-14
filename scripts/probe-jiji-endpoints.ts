#!/usr/bin/env bun
/**
 * Probe Jiji endpoints — discovers which return OK vs SOFT_CHALLENGE vs HARD_BLOCK.
 *
 * Uses curl_cffi-equivalent fetch (we don't have curl-impersonate wired into
 * Node yet, so we use Bun's native fetch — same result, just no TLS spoofing).
 *
 * Usage:
 *   bun scripts/probe-jiji-endpoints.ts
 *   bun scripts/probe-jiji-endpoints.ts --market=ke
 *   bun scripts/probe-jiji-endpoints.ts --save-cookies
 */

import { db } from "../src/lib/db";
import { saveCookie } from "../src/lib/cookie-vault";

interface ProbeResult {
  url: string;
  status: number;
  size: number;
  elapsedMs: number;
  classification: "OK" | "SOFT_CHALLENGE" | "HARD_BLOCK" | "ERROR" | "OTHER";
  cfRay?: string;
  preview: string;
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ENDPOINTS: { market: string; path: string; description: string }[] = [
  // Kenya
  { market: "ke", path: "/", description: "Homepage" },
  { market: "ke", path: "/api_web/v1/categories_counts.json", description: "Categories census" },
  { market: "ke", path: "/api_web/v1/listing?category_type=cars&ads_per_page=5", description: "Cars listing" },
  { market: "ke", path: "/api_web/v1/listing?category_type=phones&ads_per_page=5", description: "Phones listing" },
  { market: "ke", path: "/api_web/v1/item/7367333", description: "Single item (numeric GUID)" },
  { market: "ke", path: "/api_web/v1/item/7367333/data.json", description: "Item detail w/ data.json suffix" },
  { market: "ke", path: "/api_web/v1/seller/1996587/data.json", description: "Seller profile" },
  { market: "ke", path: "/api_web/v1/opinions/1996587.json", description: "Seller reviews (untested)" },
  { market: "ke", path: "/api_web/v2/listing?category_type=cars", description: "v2 listing (probe)" },
  { market: "ke", path: "/api_web/v1/featured", description: "Featured listings (probe)" },
  { market: "ke", path: "/api_web/v1/trending", description: "Trending (probe)" },
  { market: "ke", path: "/robots.txt", description: "robots.txt" },
  { market: "ke", path: "/sitemap.xml", description: "sitemap.xml" },
  // Nigeria
  { market: "ng", path: "/", description: "Homepage NG" },
  { market: "ng", path: "/api_web/v1/listing?category_type=cars&ads_per_page=5", description: "Cars listing NG" },
  // api subdomain
  { market: "ke", path: "https://api.jiji.co.ke/", description: "api.jiji.co.ke (separate hostname)" },
  { market: "ke", path: "https://api.jiji.co.ke/api_web/v1/listing?category_type=cars", description: "api subdomain /v1/listing" },
];

function classify(status: number, body: string): ProbeResult["classification"] {
  if (status === 200) return "OK";
  if (status === 403) {
    if (body.includes("Sorry, you have been blocked") || body.includes("unable to access")) {
      return "HARD_BLOCK";
    }
    if (body.includes("Just a moment") || body.includes("challenge-platform") || body.includes("cf-mitigated")) {
      return "SOFT_CHALLENGE";
    }
  }
  if (status === 503 && body.includes("Just a moment")) return "SOFT_CHALLENGE";
  if (status === 0 || status >= 500) return "ERROR";
  return "OTHER";
}

async function probe(url: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/html, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      // @ts-ignore — Bun supports this
      proxy: undefined,
    });
    clearTimeout(timeout);
    const body = await resp.text();
    const elapsedMs = Date.now() - t0;
    const cfRay = resp.headers.get("cf-ray") ?? undefined;
    return {
      url,
      status: resp.status,
      size: body.length,
      elapsedMs,
      classification: classify(resp.status, body),
      cfRay,
      preview: body.slice(0, 200).replace(/\s+/g, " "),
    };
  } catch (e: any) {
    return {
      url,
      status: 0,
      size: 0,
      elapsedMs: Date.now() - t0,
      classification: "ERROR",
      preview: e?.message ?? String(e),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const marketFilter = args.find((a) => a.startsWith("--market="))?.split("=")[1];
  const saveCookies = args.includes("--save-cookies");

  console.log("=".repeat(100));
  console.log("Jiji Endpoint Probe — discover OK / SOFT_CHALLENGE / HARD_BLOCK per endpoint");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("=".repeat(100));
  console.log();

  const targets = marketFilter
    ? ENDPOINTS.filter((e) => e.market === marketFilter)
    : ENDPOINTS;

  const MARKETS: Record<string, string> = {
    ke: "https://jiji.co.ke",
    ng: "https://jiji.ng",
  };

  console.log(
    `${"MARKET".padEnd(6)} ${"PATH".padEnd(60)} ${"STATUS".padEnd(8)} ${"SIZE".padEnd(8)} ${"TIME".padEnd(8)} ${"CLASSIFICATION".padEnd(20)} CF_RAY`
  );
  console.log("-".repeat(100));

  const results: ProbeResult[] = [];
  for (const target of targets) {
    const baseUrl = target.path.startsWith("http") ? "" : MARKETS[target.market];
    const fullUrl = `${baseUrl}${target.path}`;
    const r = await probe(fullUrl);
    results.push(r);
    console.log(
      `${target.market.padEnd(6)} ${target.path.padEnd(60).slice(0, 60)} ${String(r.status).padEnd(8)} ${String(r.size).padEnd(8)} ${String(r.elapsedMs + "ms").padEnd(8)} ${r.classification.padEnd(20)} ${r.cfRay ?? ""}`
    );
    // Brief delay to be polite
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log();
  console.log("=".repeat(100));
  console.log("SUMMARY");
  console.log("=".repeat(100));

  const counts = results.reduce(
    (acc, r) => {
      acc[r.classification]++;
      return acc;
    },
    { OK: 0, SOFT_CHALLENGE: 0, HARD_BLOCK: 0, ERROR: 0, OTHER: 0 } as Record<string, number>
  );

  console.log(`OK (200):              ${counts.OK}`);
  console.log(`SOFT_CHALLENGE (403):  ${counts.SOFT_CHALLENGE}  ← solvable with stealth browser / CapSolver`);
  console.log(`HARD_BLOCK (403):      ${counts.HARD_BLOCK}  ← IP banned, need residential proxy`);
  console.log(`ERROR:                 ${counts.ERROR}`);
  console.log(`OTHER:                 ${counts.OTHER}`);
  console.log();

  const ok = results.filter((r) => r.classification === "OK");
  if (ok.length > 0) {
    console.log("Working endpoints:");
    for (const r of ok) {
      console.log(`  ✓ ${r.url}  (${r.size} bytes, ${r.elapsedMs}ms)`);
    }
  }

  const hard = results.filter((r) => r.classification === "HARD_BLOCK");
  if (hard.length > 0) {
    console.log();
    console.log("Hard-blocked endpoints (need residential proxy):");
    for (const r of hard) {
      console.log(`  ✗ ${r.url}`);
      console.log(`    CF-Ray: ${r.cfRay}`);
    }
  }

  // Save full results to JSON
  const outPath = "/home/z/my-project/download/jiji-endpoint-probe-results.json";
  const fs = await import("fs");
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    userAgent: UA,
    results,
    summary: counts,
  }, null, 2));
  console.log();
  console.log(`Full results saved to: ${outPath}`);

  // If --save-cookies flag and any Set-Cookie headers were captured, save them
  if (saveCookies) {
    console.log();
    console.log("Note: --save-cookies flag set, but Bun's fetch doesn't expose Set-Cookie");
    console.log("      headers easily. Use scripts/save-cookie.ts to manually save a cookie.");
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
