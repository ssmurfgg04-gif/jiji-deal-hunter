#!/usr/bin/env bun
/**
 * CLI proxy validator — seeds default proxies + runs validation sweep.
 *
 * Usage:
 *   bun scripts/validate-proxies.ts                 # seed defaults + validate all
 *   bun scripts/validate-proxies.ts --no-seed       # only validate existing
 *   bun scripts/validate-proxies.ts --urls=...      # validate custom URLs (comma-separated)
 *
 * Output: prints a table of working proxies with latency, plus the count
 * of working proxies needed for the live-collector to bypass Cloudflare.
 *
 * Exit codes:
 *   0  validation completed (>=1 working proxy OR no proxies in pool)
 *   1  fatal error (DB unreachable, etc.)
 *   2  zero working proxies after validation (Cloudflare bypass unavailable)
 */

import { db } from "../src/lib/db";
import {
  validateProxies,
  seedDefaultProxies,
  seedProxyPool,
  isSafeProxyUrl,
} from "../src/lib/proxy-pool";

interface Args {
  noSeed: boolean;
  urls?: string[];
}

function parseArgs(): Args {
  const args: Args = { noSeed: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--no-seed") args.noSeed = true;
    else if (a.startsWith("--urls=")) {
      args.urls = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();

  console.log("[validate-proxies] Starting proxy validation sweep...");

  // Phase 1: Seed (unless --no-seed)
  if (args.urls && args.urls.length > 0) {
    const safe = args.urls.filter(isSafeProxyUrl);
    const rejected = args.urls.length - safe.length;
    console.log(`[validate-proxies] Seeding ${safe.length} custom URLs (${rejected} rejected by SSRF guard)`);
    const result = await seedProxyPool(safe);
    console.log(`[validate-proxies] Seeded: ${result.added} added, ${result.rejected} rejected`);
  } else if (!args.noSeed) {
    console.log("[validate-proxies] Seeding default proxy list...");
    const result = await seedDefaultProxies();
    console.log(`[validate-proxies] Seeded: ${result.added} added, ${result.rejected} rejected`);
  }

  // Phase 2: Load all proxies from DB
  const all = await db.proxyPool.findMany({
    select: { url: true },
    orderBy: [{ lastTestedAt: "asc" }],
  });
  if (all.length === 0) {
    console.log("[validate-proxies] No proxies in pool. Seed some first.");
    process.exit(0);
  }

  console.log(`[validate-proxies] Validating ${all.length} proxies against jiji.co.ke health endpoint...`);
  console.log("[validate-proxies] (this may take 10-60 seconds depending on timeouts)");
  console.log();

  const startMs = Date.now();
  const results = await validateProxies(all.map((p) => p.url), 10);
  const durationMs = Date.now() - startMs;

  const working = results.filter((r) => r.working);
  const failed = results.filter((r) => !r.working);

  // Sort working by latency ascending
  working.sort((a, b) => a.latencyMs - b.latencyMs);

  console.log("=".repeat(72));
  console.log(`VALIDATION COMPLETE — ${durationMs / 1000}s`);
  console.log("=".repeat(72));
  console.log(`Working: ${working.length} / ${results.length}  (${(working.length / results.length * 100).toFixed(0)}%)`);
  console.log();

  if (working.length > 0) {
    console.log("WORKING PROXIES (sorted by latency):");
    console.log("-".repeat(72));
    console.log("  Latency   Proxy URL");
    console.log("-".repeat(72));
    for (const r of working) {
      console.log(`  ${r.latencyMs.toString().padStart(5)}ms   ${r.url}`);
    }
    console.log();
    console.log(`[validate-proxies] ✓ ${working.length} working proxies available.`);
    console.log("[validate-proxies] Live-collector will rotate through these on Cloudflare block.");
  } else {
    console.log("FAILED PROXIES (all):");
    console.log("-".repeat(72));
    console.log("  Error              Proxy URL");
    console.log("-".repeat(72));
    for (const r of failed.slice(0, 20)) {
      const err = (r.error ?? "unknown").slice(0, 18);
      console.log(`  ${err.padEnd(18)}   ${r.url}`);
    }
    if (failed.length > 20) {
      console.log(`  ... and ${failed.length - 20} more`);
    }
    console.log();
    console.log("[validate-proxies] ✗ ZERO working proxies.");
    console.log("[validate-proxies]   Live-collector cannot bypass Cloudflare without proxies.");
    console.log("[validate-proxies]   Options:");
    console.log("[validate-proxies]     1. Buy paid residential proxies (Smartproxy/Bright Data/ScraperAPI)");
    console.log("[validate-proxies]     2. Install Crawl4AI: pip install crawl4ai && crawl4ai-setup");
    console.log("[validate-proxies]     3. Rely on Wayback fallback (already wired — pipeline stays alive)");
  }

  process.exit(working.length > 0 ? 0 : 2);
}

main().catch((e) => {
  console.error("[validate-proxies] FATAL:", e);
  process.exit(1);
});
