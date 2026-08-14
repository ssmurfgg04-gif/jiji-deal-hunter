/**
 * CF Bypass Orchestrator — Tiered fallback chain for Cloudflare challenges.
 *
 * When jiji-client.ts detects a SOFT_CHALLENGE (HTTP 403 + "Just a moment..."),
 * it calls solveCfChallenge() here. This function tries the cheapest working
 * tier first, falling back to progressively more expensive options:
 *
 *   Tier 1 — FlareSolverr (self-hosted, FREE)
 *            Solves via undetected Chrome on our IP. Returns cf_clearance
 *            cookie bound to OUR IP — works with subsequent fetches.
 *
 *   Tier 2 — Apify Jiji Africa Scraper (FREE $5/mo credit, ~$0.004/result)
 *            Hosted actor that uses residential IPs inside target country.
 *            Bypasses CF by appearing as a local user. Returns full
 *            structured dataset of listings.
 *
 *   Tier 3 — Spider.cloud /unblocker ($1/GB, requires paid credits)
 *            Hosted unblocker API. Returns body directly. No cookie exchange.
 *
 *   Tier 4 — CapSolver (~$1-3 / 1000 solves, paid)
 *            Solves Turnstile via API. Returns token + cookies.
 *
 * Per docs/CLOUDFLARE_BYPASS_RESEARCH.md: the cf_clearance cookie is the
 * single reusable artifact. One solve → ~30 min of high-throughput API
 * calls via curl-impersonate.
 *
 * All tiers log to console for observability.
 */

import { solveViaFlareSolverr, isFlareSolverrAvailable } from "./flaresolverr-client";
import { scrapeViaSpiderCloud } from "./spider-cloud-client";
import { solveAndSaveCookies, isCapSolverConfigured } from "./capsolver-client";
import { runJijiScraper, isApifyConfigured, ApifyJijiListing } from "./apify-client";

export type CfBypassTier = "flaresolverr" | "apify" | "spider-cloud" | "capsolver" | "none";

export interface CfBypassResult {
  ok: boolean;
  tier: CfBypassTier;
  body?: string;
  json?: any;
  cookiesSaved?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  // Apify-specific: returns full dataset of listings instead of single body
  apifyListings?: ApifyJijiListing[];
  itemCount?: number; // for Apify tier
}

/**
 * Extract market + category from a jiji.co.ke URL to feed into Apify scraper.
 *
 * Examples:
 *   https://jiji.co.ke/api_web/v1/listing?category_type=3-cars → { market: "ke", categorySlug: "cars" }
 *   https://jiji.co.ke/api_web/v1/listing?category_type=88-electronics → { market: "ke", categorySlug: "electronics" }
 *   https://jiji.co.ke/api_web/v1/categories_counts.json → { market: "ke", categorySlug: undefined }
 */
function parseJijiUrl(url: string): { market: string; categorySlug?: string } {
  const u = new URL(url);
  const host = u.hostname;
  // jiji.co.ke → ke, jiji.ng → ng, jiji.com.gh → gh, jiji.co.tz → tz, jiji.ug → ug
  const marketMap: Record<string, string> = {
    "jiji.co.ke": "ke",
    "jiji.ng": "ng",
    "jiji.com.gh": "gh",
    "jiji.co.tz": "tz",
    "jiji.ug": "ug",
  };
  const market = marketMap[host] ?? "ke";

  // Extract category slug from query: ?category_type=3-cars
  const cat = u.searchParams.get("category_type") ?? "";
  const slugMatch = cat.match(/^\d+-(.+)$/);
  const categorySlug = slugMatch ? slugMatch[1] : undefined;

  return { market, categorySlug };
}

/**
 * Try to solve a Cloudflare challenge for the given URL.
 * Walks through Tier 1 → Tier 2 → Tier 3 → Tier 4, returns first success.
 *
 * @param url Full URL that returned SOFT_CHALLENGE
 * @returns CfBypassResult — caller can use .json, .body, .apifyListings,
 *                           or retry original request if cookiesSaved > 0
 */
export async function solveCfChallenge(url: string): Promise<CfBypassResult> {
  const startedAt = Date.now();

  // ─── Tier 1: FlareSolverr (self-hosted, FREE) ─────────────────────────
  const flaresolverrUp = await isFlareSolverrAvailable().catch(() => false);
  if (flaresolverrUp) {
    console.log(`[cf-bypass] Tier 1 (FlareSolverr) attempting ${url}`);
    const result = await solveViaFlareSolverr(url);
    if (result.ok && result.solution) {
      let json: any = undefined;
      try {
        json = JSON.parse(result.solution.response);
      } catch {
        // Body wasn't JSON — that's fine
      }
      return {
        ok: true,
        tier: "flaresolverr",
        body: result.solution.response,
        json,
        cookiesSaved: result.cookiesSaved,
        durationMs: Date.now() - startedAt,
      };
    }
    console.warn(`[cf-bypass] Tier 1 failed: ${result.error}`);
  } else {
    console.log(`[cf-bypass] Tier 1 (FlareSolverr) not available — skipping`);
  }

  // ─── Tier 2: Apify Jiji Africa Scraper (FREE $5/mo credit) ──────────
  // Best for category/listing endpoints — returns full dataset.
  if (isApifyConfigured()) {
    const { market, categorySlug } = parseJijiUrl(url);
    console.log(
      `[cf-bypass] Tier 2 (Apify) attempting market=${market} category=${categorySlug ?? "(all)"}`
    );
    try {
      const result = await runJijiScraper({
        market: market as "ng" | "ke" | "gh" | "ug" | "tz",
        categorySlug,
        maxResults: 50, // small batch for single-URL fallback
      });
      if (result.ok && result.listings && result.listings.length > 0) {
        return {
          ok: true,
          tier: "apify",
          apifyListings: result.listings,
          itemCount: result.listings.length,
          costUsd: result.listings.length * 0.004, // FREE tier price
          durationMs: Date.now() - startedAt,
        };
      }
      console.warn(`[cf-bypass] Tier 2 failed: ${result.error ?? "no listings returned"}`);
    } catch (e: any) {
      console.warn(`[cf-bypass] Tier 2 error:`, e?.message);
    }
  } else {
    console.log(`[cf-bypass] Tier 2 (Apify) not configured — skipping`);
  }

  // ─── Tier 3: Spider.cloud /unblocker (paid) ──────────────────────────
  console.log(`[cf-bypass] Tier 3 (Spider.cloud) attempting ${url}`);
  const spiderResult = await scrapeViaSpiderCloud(url, { returnFormat: "text" });
  if (spiderResult.ok && spiderResult.content) {
    let json: any = undefined;
    try {
      json = JSON.parse(spiderResult.content);
    } catch {
      // Body wasn't JSON
    }
    return {
      ok: true,
      tier: "spider-cloud",
      body: spiderResult.content,
      json,
      costUsd: spiderResult.cost,
      durationMs: Date.now() - startedAt,
    };
  }
  console.warn(`[cf-bypass] Tier 3 failed: ${spiderResult.error}`);

  // ─── Tier 4: CapSolver (paid Turnstile solver) ───────────────────────
  if (isCapSolverConfigured()) {
    console.log(`[cf-bypass] Tier 4 (CapSolver) attempting ${url}`);
    const saved = await solveAndSaveCookies(url);
    if (saved) {
      return {
        ok: true,
        tier: "capsolver",
        cookiesSaved: 1,
        durationMs: Date.now() - startedAt,
      };
    }
    console.warn(`[cf-bypass] Tier 4 failed`);
  } else {
    console.log(`[cf-bypass] Tier 4 (CapSolver) not configured — skipping`);
  }

  return {
    ok: false,
    tier: "none",
    durationMs: Date.now() - startedAt,
    error: "All CF bypass tiers exhausted",
  };
}

/**
 * Convenience: solve + return parsed JSON.
 * Falls back through tiers until one returns JSON or apifyListings.
 */
export async function solveCfChallengeJson<T = any>(url: string): Promise<T | null> {
  const result = await solveCfChallenge(url);
  if (!result.ok) return null;
  if (result.json) return result.json as T;
  if (result.body) {
    try {
      return JSON.parse(result.body) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Diagnostic: report which CF bypass tiers are available right now.
 * Useful for the /api/health endpoint.
 */
export async function getCfBypassStatus(): Promise<{
  tier1FlareSolverr: boolean;
  tier2Apify: boolean;
  tier3SpiderCloud: boolean;
  tier4CapSolver: boolean;
}> {
  const [t1, , t3, t4] = await Promise.all([
    isFlareSolverrAvailable().catch(() => false),
    Promise.resolve(true),
    Promise.resolve(true),
    Promise.resolve(isCapSolverConfigured()),
  ]);
  return {
    tier1FlareSolverr: t1,
    tier2Apify: isApifyConfigured(),
    tier3SpiderCloud: true, // Spider.cloud always available (needs credits)
    tier4CapSolver: t4,
  };
}
