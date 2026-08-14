/**
 * CF Bypass Live Test
 *
 * Tests the full tiered fallback chain against jiji.co.ke:
 *   Tier 1: FlareSolverr (likely unavailable in sandbox — no Docker)
 *   Tier 2: Spider.cloud (always available, no-key tier)
 *   Tier 3: CapSolver (likely unconfigured — no API key)
 *
 * Runs:
 *   bun run scripts/test-cf-bypass.ts
 *
 * Or directly:
 *   bun run src/scripts/test-cf-bypass.ts
 */

import { solveCfChallenge, getCfBypassStatus } from "../src/lib/cf-bypass";
import { isFlareSolverrAvailable } from "../src/lib/flaresolverr-client";
import { scrapeViaSpiderCloud } from "../src/lib/spider-cloud-client";
import { isCapSolverConfigured } from "../src/lib/capsolver-client";

const TEST_URLS = [
  "https://jiji.co.ke/api_web/v1/categories_counts.json",
  "https://jiji.co.ke/api_web/v1/listing?category_type=3-cars&ads_per_page=5",
];

async function main() {
  console.log("=== CF Bypass Status ===");
  const status = await getCfBypassStatus();
  console.log(JSON.stringify(status, null, 2));
  console.log();

  console.log("=== Tier 1: FlareSolverr availability ===");
  const t1 = await isFlareSolverrAvailable().catch(() => false);
  console.log(`FlareSolverr: ${t1 ? "✅ AVAILABLE" : "❌ NOT AVAILABLE (no Docker)"}`);
  console.log();

  console.log("=== Tier 2: Spider.cloud no-key test ===");
  const t2 = await scrapeViaSpiderCloud(TEST_URLS[0], { returnFormat: "text" });
  if (t2.ok) {
    console.log(`✅ Spider.cloud returned ${t2.content?.length ?? 0}b body`);
    console.log(`   Status: ${t2.status}, cost: $${t2.cost ?? 0}, duration: ${t2.durationMs}ms`);
    // Try parsing as JSON
    try {
      const json = JSON.parse(t2.content ?? "");
      const keys = Object.keys(json);
      console.log(`   JSON keys: ${keys.join(", ")}`);
      if (json.categories) {
        console.log(`   ✅ Categories count: ${json.categories.length}`);
        console.log(`   First 3: ${JSON.stringify(json.categories.slice(0, 3))}`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ Body not JSON: ${t2.content?.slice(0, 200)}`);
    }
  } else {
    console.log(`❌ Spider.cloud failed: ${t2.error}`);
  }
  console.log();

  console.log("=== Tier 3: CapSolver configuration ===");
  const t3 = isCapSolverConfigured();
  console.log(`CapSolver: ${t3 ? "✅ CONFIGURED" : "❌ NOT CONFIGURED (no API key)"}`);
  console.log();

  console.log("=== Full CF Bypass Chain (solveCfChallenge) ===");
  for (const url of TEST_URLS) {
    console.log(`\n>>> Testing ${url}`);
    const result = await solveCfChallenge(url);
    console.log(`  ok: ${result.ok}`);
    console.log(`  tier: ${result.tier}`);
    console.log(`  durationMs: ${result.durationMs}`);
    console.log(`  cookiesSaved: ${result.cookiesSaved ?? 0}`);
    console.log(`  costUsd: ${result.costUsd ?? 0}`);
    if (result.body) {
      console.log(`  body length: ${result.body.length}b`);
      console.log(`  body preview: ${result.body.slice(0, 300)}`);
    }
    if (result.json) {
      const keys = Object.keys(result.json);
      console.log(`  JSON keys: ${keys.join(", ")}`);
    }
    if (result.error) {
      console.log(`  error: ${result.error}`);
    }
  }

  console.log("\n=== DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
