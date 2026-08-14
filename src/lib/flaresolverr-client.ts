/**
 * FlareSolverr Client — Tier 1 Cloudflare bypass (self-hosted, FREE).
 *
 * FlareSolverr is a proxy server that solves Cloudflare challenges via
 * undetected Chrome. We POST a URL, it returns:
 *   - The cleared response body (HTML or JSON)
 *   - The cf_clearance + __cf_bm cookies (valid ~30 min)
 *   - The User-Agent that solved the challenge (must reuse for cookie validity)
 *
 * Cookies are saved to CookieVault for reuse by jiji-client.ts.
 *
 * Deploy (Docker):
 *   docker run -d --name flaresolverr -p 8191:8191 \
 *     --restart unless-stopped \
 *     ghcr.io/flaresolverr/flaresolverr:latest
 *
 * See docs/DEPLOY_FLARESOLVERR.md for full setup.
 *
 * Per docs/CLOUDFLARE_BYPASS_RESEARCH.md section "Tier 1": one FlareSolverr
 * solve → ~30 min of curl-impersonate API throughput. Decouples cookie
 * acquisition from API calls.
 */

import { saveCookie } from "./cookie-vault";

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL ?? "http://localhost:8191/v1";
const FLARESOLVERR_TIMEOUT_MS = parseInt(
  process.env.FLARESOLVERR_TIMEOUT_MS ?? "60000",
  10
);

export interface FlareSolverrCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiry: number | null;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface FlareSolverrSolution {
  url: string;
  status: number;
  headers: Record<string, string>;
  response: string; // body (HTML or JSON-as-text)
  cookies: FlareSolverrCookie[];
  userAgent: string;
}

export interface FlareSolverrResult {
  ok: boolean;
  solution?: FlareSolverrSolution;
  error?: string;
  cookiesSaved?: number;
  durationMs?: number;
}

/**
 * Health check — is FlareSolverr reachable?
 */
export async function isFlareSolverrAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const baseUrl = FLARESOLVERR_URL.replace(/\/v1\/?$/, "");
    const r = await fetch(`${baseUrl}/`, { signal: controller.signal });
    clearTimeout(t);
    return r.ok || r.status === 200;
  } catch {
    return false;
  }
}

/**
 * Solve a Cloudflare challenge for the given URL via FlareSolverr.
 * Saves cf_clearance + __cf_bm cookies to CookieVault for reuse.
 * Returns the cleared response body + solution metadata.
 *
 * Usage:
 *   const result = await solveViaFlareSolverr(
 *     "https://jiji.co.ke/api_web/v1/categories_counts.json"
 *   );
 *   if (result.ok && result.solution) {
 *     const json = JSON.parse(result.solution.response);
 *   }
 */
export async function solveViaFlareSolverr(
  url: string,
  options: { maxTimeoutMs?: number } = {}
): Promise<FlareSolverrResult> {
  const maxTimeout = options.maxTimeoutMs ?? FLARESOLVERR_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), maxTimeout + 5000);

    const body = JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout,
    });

    const r = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `FlareSolverr HTTP ${r.status}: ${text.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const json: any = await r.json();
    if (json.status !== "ok" || !json.solution) {
      return {
        ok: false,
        error: json.message ?? "FlareSolverr returned no solution",
        durationMs: Date.now() - startedAt,
      };
    }

    const solution = json.solution as FlareSolverrSolution;

    // Save cookies to CookieVault for reuse by jiji-client.ts.
    // Cookies are bound to (domain, userAgent, proxyIp=null since FlareSolverr
    // uses our own IP), so they'll work with our direct fetches.
    const targetDomain = new URL(url).hostname;
    let savedCount = 0;
    for (const cookie of solution.cookies) {
      if (cookie.name === "cf_clearance" || cookie.name === "__cf_bm") {
        try {
          // Calculate TTL from cookie expiry (epoch seconds)
          const ttlMinutes = cookie.expiry
            ? Math.max(1, Math.floor((cookie.expiry * 1000 - Date.now()) / 60000))
            : 30;
          await saveCookie({
            domain: targetDomain,
            name: cookie.name,
            value: cookie.value,
            userAgent: solution.userAgent,
            proxyIp: null, // FlareSolverr uses our IP
            source: "flaresolverr",
            ttlMinutes,
          });
          savedCount++;
        } catch (e: any) {
          console.warn(
            `[flaresolverr] Failed to save cookie ${cookie.name}:`,
            e?.message
          );
        }
      }
    }

    console.log(
      `[flaresolverr] Solved ${url} — ${savedCount} cookies saved, ` +
        `UA=${solution.userAgent.slice(0, 40)}..., ` +
        `body=${solution.response.length}b`
    );

    return {
      ok: true,
      solution,
      cookiesSaved: savedCount,
      durationMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    return {
      ok: false,
      error:
        e?.name === "AbortError" ? "timeout" : String(e?.message ?? "network error"),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Try to solve + parse JSON in one shot.
 * Returns null on any failure (does not throw).
 */
export async function solveJsonViaFlareSolverr<T = any>(
  url: string
): Promise<T | null> {
  const result = await solveViaFlareSolverr(url);
  if (!result.ok || !result.solution) {
    console.warn(`[flaresolverr] Failed: ${result.error}`);
    return null;
  }
  try {
    return JSON.parse(result.solution.response) as T;
  } catch (e: any) {
    console.warn(
      `[flaresolverr] JSON parse failed:`,
      e?.message,
      `(body was ${result.solution.response.length}b, first 200: ${result.solution.response.slice(0, 200)})`
    );
    return null;
  }
}
