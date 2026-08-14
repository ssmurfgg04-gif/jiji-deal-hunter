/**
 * CF Bypass Live Test — exercises full tiered fallback chain.
 *
 * Tests:
 *   1. Get CF bypass status (which tiers are available)
 *   2. Test Apify Jiji Africa scraper directly on jiji.ng cars
 *   3. Test Spider.cloud /unblocker on jiji.co.ke (will fail without credits)
 *   4. Test full solveCfChallenge() chain on a jiji.co.ke URL
 *
 * Run:
 *   bun run scripts/test-cf-bypass.ts
 */

import { solveCfChallenge, getCfBypassStatus } from "../src/lib/cf-bypass";
import { isFlareSolverrAvailable } from "../src/lib/flaresolverr-client";
import { scrapeViaSpiderCloud } from "../src/lib/spider-cloud-client";
import { runJijiScraper, getApifyUsage, isApifyConfigured } from "../src/lib/apify-client";
import { isCapSolverConfigured } from "../src/lib/capsolver-client";

async function main() {
  console.log("=== Loading .env ===");
  // bun auto-loads .env
  console.log("SPIDER_API_KEY:", process.env.SPIDER_API_KEY ? "✅ set" : "❌ missing");
  console.log("APIFY_API_TOKEN:", process.env.APIFY_API_TOKEN ? "✅ set" : "❌ missing");
  console.log("CAPSOLVER_API_KEY:", process.env.CAPSOLVER_API_KEY ? "✅ set" : "❌ missing");
  console.log();

  console.log("=== CF Bypass Tier Status ===");
  const status = await getCfBypassStatus();
  console.log(JSON.stringify(status, null, 2));
  console.log();

  console.log("=== Tier 1: FlareSolverr ===");
  const t1 = await isFlareSolverrAvailable().catch(() => false);
  console.log(`  ${t1 ? "✅ AVAILABLE" : "❌ NOT AVAILABLE (no Docker)"}`);
  console.log();

  console.log("=== Tier 2: Apify ===");
  if (isApifyConfigured()) {
    const usage = await getApifyUsage();
    console.log(`  ✅ CONFIGURED — plan=${usage.plan}, $${usage.monthlyUsageCreditsUsd}/mo credit`);
    console.log(`  Running test scrape: jiji.ng cars, maxResults=20`);
    const result = await runJijiScraper({
      market: "ng",
      categorySlug: "cars",
      maxResults: 20,
    });
    if (result.ok && result.listings) {
      console.log(`  ✅ SUCCESS — ${result.listings.length} listings received`);
      console.log(`     runId: ${result.runId}`);
      console.log(`     duration: ${result.durationMs}ms`);
      console.log(`     est cost: $${(result.listings.length * 0.004).toFixed(4)}`);
      console.log(`     first 3 listings:`);
      for (const l of result.listings.slice(0, 3)) {
        console.log(`       - ${l.title} | ${l.priceLabel ?? l.price} | ${l.region}`);
      }
    } else {
      console.log(`  ❌ FAILED: ${result.error}`);
    }
  } else {
    console.log("  ❌ NOT CONFIGURED");
  }
  console.log();

  console.log("=== Tier 3: Spider.cloud /unblocker ===");
  const t3 = await scrapeViaSpiderCloud(
    "https://jiji.co.ke/api_web/v1/categories_counts.json",
    { returnFormat: "text" }
  );
  if (t3.ok) {
    console.log(`  ✅ SUCCESS — ${t3.content?.length}b body, cost=$${t3.cost}`);
  } else {
    console.log(`  ❌ FAILED: ${t3.error}`);
    console.log(`     (Expected if no credits — Spider.cloud free tier doesn't cover /unblocker)`);
  }
  console.log();

  console.log("=== Tier 4: CapSolver ===");
  console.log(`  ${isCapSolverConfigured() ? "✅ CONFIGURED" : "❌ NOT CONFIGURED"}`);
  console.log();

  console.log("=== Full CF Bypass Chain Test ===");
  console.log(">>> https://jiji.co.ke/api_web/v1/listing?category_type=3-cars&ads_per_page=5");
  const result = await solveCfChallenge(
    "https://jiji.co.ke/api_web/v1/listing?category_type=3-cars&ads_per_page=5"
  );
  console.log(`  ok: ${result.ok}`);
  console.log(`  tier: ${result.tier}`);
  console.log(`  durationMs: ${result.durationMs}`);
  console.log(`  itemCount: ${result.itemCount ?? 0}`);
  console.log(`  costUsd: $${result.costUsd?.toFixed(6) ?? 0}`);
  if (result.apifyListings && result.apifyListings.length > 0) {
    console.log(`  ✅ Got ${result.apifyListings.length} Apify listings`);
    console.log(`  First listing:`);
    console.log(`    title: ${result.apifyListings[0].title}`);
    console.log(`    price: ${result.apifyListings[0].priceLabel}`);
    console.log(`    url: ${result.apifyListings[0].url}`);
  }
  if (result.error) console.log(`  error: ${result.error}`);

  console.log("\n=== DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
