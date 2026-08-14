/**
 * CF Bypass Orchestrator — Tiered fallback chain for Cloudflare challenges.
 *
 * When jiji-client.ts detects a SOFT_CHALLENGE (HTTP 403 + "Just a moment..."),
 * it calls solveCfChallenge() here. This function tries the cheapest working
 * tier first, falling back to progressively more expensive options:
 *
 *   Tier 1 — FlareSolverr (self-hosted, FREE)
 *            Solves via undetected Chrome on our IP. Returns cf_clearance
 *            cookie bound to OUR IP — works with subsequent curl-impersonate
 *            fetches.
 *
 *   Tier 2 — Spider.cloud ($1/GB, freemium)
 *            Hosted scraper. Returns body directly. No cookie exchange.
 *            Always works as long as Spider.cloud is up.
 *
 *   Tier 3 — CapSolver (~$1-3 / 1000 solves, paid)
 *            Solves Turnstile via API. Returns token + cookies.
 *
 * Per docs/CLOUDFLARE_BYPASS_RESEARCH.md: the cf_clearance cookie is the
 * single reusable artifact. One solve → ~30 min of high-throughput API
 * calls via curl-impersonate.
 *
 * All tiers log to console for observability. Caller decides whether to
 * retry the original request (Tier 1, 3) or use the returned body (Tier 2).
 */

import { solveViaFlareSolverr, isFlareSolverrAvailable, solveJsonViaFlareSolverr } from "./flaresolverr-client";
import { scrapeViaSpiderCloud, fetchJsonViaSpiderCloud } from "./spider-cloud-client";
import { solveAndSaveCookies, isCapSolverConfigured } from "./capsolver-client";

export type CfBypassTier = "flaresolverr" | "spider-cloud" | "capsolver" | "none";

export interface CfBypassResult {
  ok: boolean;
  tier: CfBypassTier;
  body?: string; // raw response body (if available)
  json?: any; // parsed JSON (if body was JSON)
  cookiesSaved?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Try to solve a Cloudflare challenge for the given URL.
 * Walks through Tier 1 → Tier 2 → Tier 3, returns first success.
 *
 * @param url Full URL that returned SOFT_CHALLENGE
 * @returns CfBypassResult — caller can use .json or .body, or retry original request if cookiesSaved > 0
 */
export async function solveCfChallenge(url: string): Promise<CfBypassResult> {
  const startedAt = Date.now();

  // ─── Tier 1: FlareSolverr (self-hosted, FREE) ─────────────────────────
  // Best case: solves on our IP, cookies bind to our IP, works with curl-impersonate.
  const flaresolverrUp = await isFlareSolverrAvailable().catch(() => false);
  if (flaresolverrUp) {
    console.log(`[cf-bypass] Tier 1 (FlareSolverr) attempting ${url}`);
    const result = await solveViaFlareSolverr(url);
    if (result.ok && result.solution) {
      // Try to parse body as JSON (most Jiji API endpoints return JSON)
      let json: any = undefined;
      try {
        json = JSON.parse(result.solution.response);
      } catch {
        // Body wasn't JSON — that's fine, caller can use .body
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

  // ─── Tier 2: Spider.cloud (freemium hosted scraper) ──────────────────
  // Always available (has no-key tier). Returns body directly.
  console.log(`[cf-bypass] Tier 2 (Spider.cloud) attempting ${url}`);
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
  console.warn(`[cf-bypass] Tier 2 failed: ${spiderResult.error}`);

  // ─── Tier 3: CapSolver (paid Turnstile solver) ───────────────────────
  // Only attempt if API key is configured. Solves Turnstile, saves cookies
  // to vault. Caller should RETRY the original request after this succeeds.
  if (isCapSolverConfigured()) {
    console.log(`[cf-bypass] Tier 3 (CapSolver) attempting ${url}`);
    const saved = await solveAndSaveCookies(url);
    if (saved) {
      return {
        ok: true,
        tier: "capsolver",
        cookiesSaved: 1,
        durationMs: Date.now() - startedAt,
        // No body — caller must retry original request to get body
      };
    }
    console.warn(`[cf-bypass] Tier 3 failed`);
  } else {
    console.log(`[cf-bypass] Tier 3 (CapSolver) not configured — skipping`);
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
 * Tries Tier 1 → Tier 2 → (Tier 3 doesn't return body, so caller retries).
 *
 * If Tier 3 succeeds (cookies saved but no body), returns null.
 * Caller should retry the original request — the saved cookie will be picked
 * up by tryFetch() automatically.
 */
export async function solveCfChallengeJson<T = any>(url: string): Promise<T | null> {
  const result = await solveCfChallenge(url);

  if (!result.ok) return null;

  if (result.json) return result.json as T;

  // Tier 3 (CapSolver) succeeded but didn't return a body.
  // Caller should retry the original request.
  if (result.tier === "capsolver" && result.cookiesSaved) {
    console.log(`[cf-bypass] Tier 3 saved cookies — caller should retry original request`);
  }

  return null;
}

/**
 * Diagnostic: report which CF bypass tiers are available right now.
 * Useful for the /api/health endpoint.
 */
export async function getCfBypassStatus(): Promise<{
  tier1FlareSolverr: boolean;
  tier2SpiderCloud: boolean;
  tier3CapSolver: boolean;
}> {
  const [t1, t2, t3] = await Promise.all([
    isFlareSolverrAvailable().catch(() => false),
    Promise.resolve(true), // Spider.cloud always available (no-key tier)
    Promise.resolve(isCapSolverConfigured()),
  ]);
  return {
    tier1FlareSolverr: t1,
    tier2SpiderCloud: t2,
    tier3CapSolver: t3,
  };
}
