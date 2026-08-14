/**
 * Jiji API Client — LIVE ONLY
 *
 * Multi-market (Kenya, Nigeria, Ghana, Tanzania, Uganda).
 *
 * Endpoints (verified via recon):
 *   GET /api_web/v1/categories_counts.json       — market census (catId → count)
 *   GET /api_web/v1/listing?category_type={id}-{slug}&ads_per_page=100
 *                                                   — category feed with next_url pagination
 *   GET /api_web/v1/listing?user_id={numeric}&page=N
 *                                                   — seller inventory (every ad has user_phone)
 *   GET /api_web/v1/item/{guid}/data.json        — full item detail + moderation history
 *   GET /api_web/v1/seller/{id}/data.json        — seller profile (adverts_count, feedback_count)
 *   GET /api_web/v1/opinions/{id}.json           — seller reviews (test if exists)
 *   GET /api_web/v1/search?q=...&min_price=...&max_price=...&sort=...&page=1
 *                                                   — filtered search
 *
 * Pacing: 1-2 seconds between requests, single-threaded.
 *
 * PROXY ROTATION (added 2026-08): Cloudflare now actively blocks our IP range
 * with 403+HTML challenges on the API endpoints. On Cloudflare block, the
 * client transparently rotates through the working ProxyPool entries (validated
 * against the target's health endpoint — see proxy-pool.ts). If no proxies are
 * available, returns null and the caller's Wayback fallback kicks in.
 *
 * IMPORTANT: This client does NOT silently fall back to synthetic data. If a live
 * call fails, it returns null and the caller decides how to handle the gap
 * (typically by logging to CollectionRun.log and continuing).
 */

import { db } from "./db";
import { pickProxy, seedDefaultProxies, markProxyFailed } from "./proxy-pool";

export const MARKETS = [
  { id: "ke", name: "Kenya", baseUrl: "https://jiji.co.ke", currency: "KES" },
  { id: "ng", name: "Nigeria", baseUrl: "https://jiji.ng", currency: "NGN" },
  { id: "gh", name: "Ghana", baseUrl: "https://jiji.com.gh", currency: "GHS" },
  { id: "tz", name: "Tanzania", baseUrl: "https://jiji.co.tz", currency: "TZS" },
  { id: "ug", name: "Uganda", baseUrl: "https://jiji.ug", currency: "UGX" },
] as const;

export type MarketId = (typeof MARKETS)[number]["id"];

export interface MarketCensusEntry {
  catId: number;
  slug: string;
  name?: string;
  count: number;
}

export interface JijiImage {
  url: string;
  width: number;
  height: number;
}

export interface JijiSeller {
  id: string;
  marketId: string;
  numericUserId: number;
  username: string;
  location: string | null;
  account_age_days: number;
  total_items: number;
  adverts_count: number;
  feedback_count: number;
  rating: number;
  hide_phone: boolean;
  phone: string | null;
  verified_badge: boolean;
}

export interface JijiListing {
  id: string;
  marketId: string;
  guid: string;
  title: string;
  price: number;
  currency: string;
  category: string;
  category_id: number | null;
  condition: string;
  location: string | null;
  url: string | null;
  images: JijiImage[];
  views: number;
  fav_count: number;
  days_on_market: number;
  // Scam-signal timestamps
  date_created: string | null;
  date_edited: string | null;
  date_moderated: string | null;
  // Scam-signal booleans
  status: string;
  status_color: string | null;
  sold_reported: boolean;
  can_make_an_offer: boolean;
  abuse_reported: boolean;
  is_boost: boolean;
  paid_info: any;
  available_tops_count: number;
  // Jiji's own market price valuation (free scam signal)
  price_valuation_low: number | null;
  price_valuation_high: number | null;
  price_valuation_label: string | null;
  price_valuation_url: string | null;
  seller: JijiSeller;
  price_history: { price: number; recorded_at: string }[];
}

export interface JijiSearchResult {
  items: JijiListing[];
  total: number;
  page: number;
  next_url: string | null;
}

export interface LiveApiStatus {
  lastMode: "live" | "blocked" | "error";
  lastCheckedAt: string | null;
  lastError: string | null;
  liveSuccessCount: number;
  failureCount: number;
}

/**
 * @deprecated Use getLiveApiStatus() / recordLiveApi() instead.
 *
 * This in-memory object is kept ONLY for backward compatibility with code
 * that reads it directly. It is updated as a side-effect of recordLive() /
 * recordFailure(), but the authoritative state is in the ServerState table.
 * Reads should go through getLiveApiStatus() — that hits the DB and works
 * across serverless instances.
 */
export const liveApiStatus: LiveApiStatus = {
  lastMode: "live",
  lastCheckedAt: null,
  lastError: null,
  liveSuccessCount: 0,
  failureCount: 0,
};

const SINGLETON_ID = "singleton";

/**
 * Read the authoritative live-API status from the DB (serverless-safe).
 */
export async function getLiveApiStatus(): Promise<LiveApiStatus> {
  const state = await db.serverState.findUnique({ where: { id: SINGLETON_ID } });
  if (!state) {
    return { ...liveApiStatus };
  }
  return {
    lastMode: state.liveApiLastMode as LiveApiStatus["lastMode"],
    lastCheckedAt: state.liveApiLastCheckedAt?.toISOString() ?? null,
    lastError: state.liveApiLastError,
    liveSuccessCount: state.liveApiSuccessCount,
    failureCount: state.liveApiFailureCount,
  };
}

/**
 * Rotating user-agent pool.
 *
 * Static single-UA scraping gets fingerprinted and blocked by Cloudflare
 * within hours. Rotating across a realistic pool of recent browser UAs
 * spreads the signal — combined with the 1.2s pacing, this is what's kept
 * the collector from being WAF-blocked in production.
 *
 * Updated 2026-08 to current stable browser versions. Cloudflare flags
 * outdated Chrome UAs (more than ~6 months old) as suspicious — keep these
 * refreshed every quarter. Source: https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping
 */
const USER_AGENTS = [
  // Chrome 131–134 (stable as of Q3 2026)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  // Firefox 130–133
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
  // Safari 17.5+ (current)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  // Mobile Safari (iOS 17.5+)
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // Edge (Chromium) — common on Windows corporate
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function defaultHeaders(marketId: string): Record<string, string> {
  const market = MARKETS.find((m) => m.id === marketId);
  return {
    "User-Agent": pickUserAgent(),
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${market?.baseUrl ?? "https://jiji.co.ke"}/`,
    "X-Requested-With": "XMLHttpRequest",
    "Cache-Control": "no-cache",
  };
}

/**
 * Extract the proxy IP from a proxy URL for CookieVault keying.
 * Returns null for direct (no-proxy) requests.
 * Cloudflare binds cf_clearance to the IP that solved the challenge, so
 * a cookie obtained via proxy A will NOT work via proxy B.
 */
function proxyIpFromUrl(proxyUrl: string | null): string | null {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * Pacing between requests (milliseconds).
 *
 * Default: 1200ms (1.2 req/sec) — fine for interactive use in the dashboard.
 * Override via JIJI_REQUEST_DELAY_MS for batch scripts (live-collector.ts
 * sets this to 3000ms = 1 req / 3 sec for polite weekly scraping).
 *
 * The value is read fresh on every pacedDelay() call so env updates at
 * runtime take effect immediately (no restart needed).
 */
function getRequestDelayMs(): number {
  const env = parseInt(process.env.JIJI_REQUEST_DELAY_MS ?? "", 10);
  return Number.isNaN(env) || env < 200 ? 1200 : env;
}

let lastRequestAt = 0;
// Promise chain that serializes all pacedDelay calls.
// Without this, N concurrent callers all read lastRequestAt, all sleep, all
// fire simultaneously — defeating the rate limiter.
let pacedChain: Promise<void> = Promise.resolve();

function pacedDelay(): Promise<void> {
  const delayMs = getRequestDelayMs();
  const next = pacedChain.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < delayMs) {
      await new Promise((r) => setTimeout(r, delayMs - elapsed));
    }
    lastRequestAt = Date.now();
  });
  // Keep the chain alive even if one caller throws
  pacedChain = next.catch(() => {});
  return next;
}

/**
 * Sleep helper for exponential backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function recordLive() {
  liveApiStatus.lastMode = "live";
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = null;
  liveApiStatus.liveSuccessCount++;
  // Persist to DB (fire-and-forget — don't block the request on a status write).
  // Catch unhandled rejections so a DB outage doesn't crash the collector.
  void db.serverState.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      liveApiLastMode: "live",
      liveApiLastCheckedAt: new Date(),
      liveApiLastError: null,
      liveApiSuccessCount: 1,
    },
    update: {
      liveApiLastMode: "live",
      liveApiLastCheckedAt: new Date(),
      liveApiLastError: null,
      liveApiSuccessCount: { increment: 1 },
    },
  }).catch((e) => {
    // Log once per minute at most — avoids log spam during prolonged DB outages
    const now = Date.now();
    if (now - lastStatusWriteErrorLoggedAt > 60_000) {
      console.warn("[jiji-client] DB write failed in recordLive():", e?.message);
      lastStatusWriteErrorLoggedAt = now;
    }
  });
}

let lastStatusWriteErrorLoggedAt = 0;

function recordFailure(mode: "blocked" | "error", reason: string) {
  liveApiStatus.lastMode = mode;
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = reason;
  liveApiStatus.failureCount++;
  void db.serverState.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      liveApiLastMode: mode,
      liveApiLastCheckedAt: new Date(),
      liveApiLastError: reason,
      liveApiFailureCount: 1,
    },
    update: {
      liveApiLastMode: mode,
      liveApiLastCheckedAt: new Date(),
      liveApiLastError: reason,
      liveApiFailureCount: { increment: 1 },
    },
  }).catch((e) => {
    const now = Date.now();
    if (now - lastStatusWriteErrorLoggedAt > 60_000) {
      console.warn("[jiji-client] DB write failed in recordFailure():", e?.message);
      lastStatusWriteErrorLoggedAt = now;
    }
  });
}

/**
 * Core fetch with timeout + Cloudflare detection + retry/backoff + proxy rotation.
 * Returns null on any failure (does NOT throw — caller decides how to handle).
 *
 * Retry strategy:
 *   - 1 retry on transient network errors (AbortError, ECONNRESET, etc.)
 *   - 1 retry on 429 / 503 with Retry-After honor
 *   - On Cloudflare 403+HTML: try up to 3 working proxies from ProxyPool
 *     (each proxy gets its own paced delay). If all proxies blocked, return null.
 *   - NO retry on 4xx other than 429 (client error, won't fix itself)
 */
async function tryLiveApi<T>(
  marketId: string,
  path: string,
  opts: { timeoutMs?: number; params?: Record<string, string | number | undefined> } = {}
): Promise<T | null> {
  const market = MARKETS.find((m) => m.id === marketId);
  if (!market) return null;

  const url = new URL(`${market.baseUrl}/api_web/v1${path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  // Direct attempt first (fast path — no proxy overhead if not blocked)
  const directResult = await tryFetch<T>(marketId, url.toString(), null, opts.timeoutMs);
  if (directResult !== "CLOUDFLARE_BLOCKED" &&
      directResult !== "CLOUDFLARE_SOFT_CHALLENGE" &&
      directResult !== "CLOUDFLARE_HARD_BLOCK") {
    return directResult;
  }

  // Direct call was Cloudflare-blocked. Behavior depends on block type.
  const blockType = directResult as CloudflareBlockType;

  if (blockType === "CLOUDFLARE_HARD_BLOCK") {
    // HARD_BLOCK means our IP is permanently banned on this site.
    // No point trying proxies from the SAME datacenter — they'll be banned too.
    // Log once and fall through to proxy rotation (in case we have residential).
    console.warn(`[jiji-client] HARD_BLOCK on ${url.pathname} — IP is banned. Need residential proxy.`);
    recordFailure("blocked", `HARD_BLOCK on ${marketId} — IP banned`);
    // Don't waste time on free public proxies — they're datacenter IPs too.
    // Fall through to Wayback fallback in caller.
    return null;
  }

  // SOFT_CHALLENGE — solvable via FlareSolverr / Apify / Spider.cloud / CapSolver.
  // Per docs/CLOUDFLARE_BYPASS_RESEARCH.md: tiered fallback chain.
  //   Tier 1: FlareSolverr (self-hosted, FREE) — solves on our IP, saves cf_clearance
  //   Tier 2: Apify Jiji Africa Scraper (FREE $5/mo credit) — residential IPs, full dataset
  //   Tier 3: Spider.cloud /unblocker (paid) — returns body directly
  //   Tier 4: CapSolver (paid) — solves Turnstile, saves cookies
  console.warn(`[jiji-client] Cloudflare SOFT_CHALLENGE on ${url.pathname} — invoking CF bypass chain...`);

  try {
    const { solveCfChallenge } = await import("./cf-bypass");
    const cfResult = await solveCfChallenge(url.toString());
    if (cfResult.ok) {
      console.log(
        `[jiji-client] CF bypass succeeded via ${cfResult.tier} ` +
          `(${cfResult.durationMs}ms, cookiesSaved=${cfResult.cookiesSaved ?? 0})`
      );

      // Tier 2 (Apify): returns full dataset of listings — caller decides how
      // to handle. Caller is typically fetchCategoryFeed() which expects
      // { adverts: [...] } shape; we convert Apify format to that shape.
      if (cfResult.apifyListings && cfResult.apifyListings.length > 0) {
        console.log(
          `[jiji-client] Apify returned ${cfResult.apifyListings.length} listings — ` +
            `converting to Jiji API shape`
        );
        // Convert Apify listings to the shape Jiji's /api_web/v1/listing returns
        const fakeResponse: any = {
          adverts: cfResult.apifyListings.map((a) => ({
            id: a.guid,
            advert_id: a.advertId ?? a.guid,
            guid: a.guid,
            title: a.title,
            url: a.url,
            price_obj: { price: a.price, currency: a.currency },
            // Apify output has flattened seller fields (sellerName, sellerId, etc.)
            // Jiji API expects nested user object
            user: {
              id: a.sellerId,
              name: a.sellerName,
              rating: a.sellerRating,
              verified: a.isVerifiedId,
              verified_badge: a.isVerifiedId,
            },
            // Apify returns imageUrls as comma-separated string
            images: (a.imageUrls ?? "").split(",").filter(Boolean).map((u: string) => ({ url: u.trim() })),
            count_views: 0,
            fav_count: 0,
            status: a.status ?? "active",
            is_boost: a.isPromoted ?? false,
            date_created: a.scrapedAt,
            date_edited: null,
            date_moderated: null,
            category: { slug: a.categorySlug, id: a.categoryId, name: a.category },
            region: { name: a.region },
          })),
          // Apify doesn't paginate — single batch
          next_url: null,
        };
        recordLive();
        return fakeResponse as T;
      }

      // Tier 1 & 3: body is available — return parsed JSON directly
      if (cfResult.json) {
        recordLive();
        return cfResult.json as T;
      }
      if (cfResult.body) {
        try {
          const parsed = JSON.parse(cfResult.body) as T;
          recordLive();
          return parsed;
        } catch {
          // Body wasn't JSON — fall through to retry
        }
      }

      // Tier 4 (CapSolver): cookies saved but no body — retry original fetch
      // The saved cf_clearance will be picked up by tryFetch() automatically.
      if (cfResult.cookiesSaved && cfResult.cookiesSaved > 0) {
        console.log(`[jiji-client] Retrying original request with new cf_clearance cookie...`);
        const retryResult = await tryFetch<T>(marketId, url.toString(), null, opts.timeoutMs);
        if (retryResult !== "CLOUDFLARE_BLOCKED" &&
            retryResult !== "CLOUDFLARE_SOFT_CHALLENGE" &&
            retryResult !== "CLOUDFLARE_HARD_BLOCK") {
          return retryResult;
        }
      }
    } else {
      console.warn(`[jiji-client] CF bypass chain exhausted: ${cfResult.error}`);
    }
  } catch (e: any) {
    console.warn(`[jiji-client] CF bypass chain error:`, e?.message);
  }

  // CF bypass failed — fall through to proxy rotation as last resort.
  console.warn(`[jiji-client] Falling back to proxy rotation...`);

  // Lazy seed on first block (idempotent — skips existing entries)
  await seedDefaultProxies().catch(() => null);

  const maxProxies = 3;
  let proxiesTried = 0;
  let hardBlocked = false;
  for (let i = 0; i < maxProxies; i++) {
    const proxyUrl = await pickProxy().catch(() => null);
    if (!proxyUrl) {
      console.warn(`[jiji-client] No working proxies left in pool (tried ${i}).`);
      break;
    }
    proxiesTried++;
    console.log(`[jiji-client] Retrying via proxy [${i + 1}/${maxProxies}]: ${proxyUrl}`);
    const result = await tryFetch<T>(marketId, url.toString(), proxyUrl, opts.timeoutMs);
    if (result !== "CLOUDFLARE_BLOCKED" &&
        result !== "CLOUDFLARE_SOFT_CHALLENGE" &&
        result !== "CLOUDFLARE_HARD_BLOCK") {
      return result;
    }
    if (result === "CLOUDFLARE_HARD_BLOCK") {
      console.warn(`[jiji-client] Proxy ${proxyUrl} HARD_BLOCKED — IP is banned, marking proxy as failed.`);
      // Mark this proxy as failed — it's on a banned IP range
      await markProxyFailed(proxyUrl).catch(() => null);
      hardBlocked = true;
    } else {
      console.warn(`[jiji-client] Proxy ${proxyUrl} also soft-challenged — trying next...`);
    }
  }

  if (hardBlocked && proxiesTried > 0) {
    recordFailure("blocked", `All ${proxiesTried} proxies HARD_BLOCKED — need residential IPs`);
  } else {
    recordFailure("blocked", `CF bypass + ${proxiesTried} proxies exhausted (Cloudflare SOFT_CHALLENGE)`);
  }
  return null;
}

/**
 * Distinguishes two classes of Cloudflare 403:
 *   - SOFT_CHALLENGE: "Just a moment..." page — solvable with stealth browser / residential proxy / CapSolver.
 *     Our IP is NOT banned; the request just needs to solve the Turnstile challenge.
 *   - HARD_BLOCK: "Sorry, you have been blocked" page — IP is permanently banned.
 *     Retrying with the same IP will NEVER succeed; must rotate to a new IP.
 *
 * Per WAF_BYPASS_RESEARCH.md: 3/8 Jiji regional sites hard-block our sandbox IP,
 * 5/8 soft-challenge us. Without differentiation we waste proxy rotations on
 * dead IPs.
 */
export type CloudflareBlockType = "CLOUDFLARE_SOFT_CHALLENGE" | "CLOUDFLARE_HARD_BLOCK";

// Legacy alias for backwards-compat (old callers compared against "CLOUDFLARE_BLOCKED")
export const CLOUDFLARE_BLOCKED = "CLOUDFLARE_BLOCKED" as const;
export type FetchResult<T> = T | null | CloudflareBlockType | typeof CLOUDFLARE_BLOCKED;

/**
 * Classify a 403 response body to determine if it's a soft challenge or hard IP ban.
 * Hard blocks MUST trigger proxy rotation; soft challenges MAY trigger CapSolver/nodriver.
 */
function classifyCloudflareBlock(body: string): CloudflareBlockType {
  // Hard block: "Sorry, you have been blocked. You are unable to access jiji.co.ke"
  if (body.includes("Sorry, you have been blocked") ||
      body.includes("unable to access") ||
      body.includes("Cloudflare Ray ID") && body.includes("blocked")) {
    return "CLOUDFLARE_HARD_BLOCK";
  }
  // Soft challenge: "Just a moment..." / "Enable JavaScript and cookies"
  if (body.includes("Just a moment") ||
      body.includes("cf-mitigated: challenge") ||
      body.includes("Enable JavaScript and cookies") ||
      body.includes("challenge-platform")) {
    return "CLOUDFLARE_SOFT_CHALLENGE";
  }
  // Default: treat as soft challenge (safer — at least tries one more rotation)
  return "CLOUDFLARE_SOFT_CHALLENGE";
}

/**
 * Single fetch attempt with optional proxy. Returns:
 *   - T (the parsed JSON) on success
 *   - null on non-Cloudflare failure (4xx, 5xx, network error)
 *   - "CLOUDFLARE_SOFT_CHALLENGE" on 403 + "Just a moment..." (try CapSolver/stealth)
 *   - "CLOUDFLARE_HARD_BLOCK" on 403 + "Sorry, you have been blocked" (rotate IP)
 *   - "CLOUDFLARE_BLOCKED" (legacy alias) — only returned if classification fails
 */
async function tryFetch<T>(
  marketId: string,
  url: string,
  proxyUrl: string | null,
  timeoutMs?: number
): Promise<T | null | CloudflareBlockType | typeof CLOUDFLARE_BLOCKED> {
  await pacedDelay();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 8000);

    // Build headers — include CookieVault cookies if available for this UA + domain.
    // Per WAF_BYPASS_RESEARCH.md section 6.2: cf_clearance cookie (when present)
    // bypasses the Cloudflare challenge entirely for ~30 min after solve.
    const headers = defaultHeaders(marketId);
    const market = MARKETS.find((m) => m.id === marketId);
    const targetDomain = market?.baseUrl
      ? new URL(market.baseUrl).hostname
      : "jiji.co.ke";
    try {
      const { getAllValidCookies, formatCookieHeader } = await import("./cookie-vault");
      const cookies = await getAllValidCookies(targetDomain, headers["User-Agent"], proxyIpFromUrl(proxyUrl));
      if (cookies.length > 0) {
        headers["Cookie"] = formatCookieHeader(cookies);
      }
    } catch {
      // cookie-vault may not be available (e.g. during tests). Don't block.
    }

    // Node 22+ supports `proxy` in fetch init. Cast to any for TS DOM lib compatibility.
    const init: any = {
      headers,
      signal: controller.signal,
      cache: "no-store",
    };
    if (proxyUrl) init.proxy = proxyUrl;
    const resp = await fetch(url, init);
    clearTimeout(timeout);

    // Cloudflare challenge pages return 403 with HTML body — classify and signal caller.
    if (resp.status === 403) {
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) {
        // Drain body to read challenge type
        const body = await resp.text().catch(() => "");
        const blockType = classifyCloudflareBlock(body);
        if (!proxyUrl) {
          recordFailure("blocked", `Cloudflare ${blockType.replace("CLOUDFLARE_", "")} (403 + HTML)`);
        }
        // If we sent a cookie and still got blocked, invalidate it — it's stale.
        if (headers["Cookie"]) {
          try {
            const { invalidateCookie } = await import("./cookie-vault");
            await invalidateCookie(targetDomain, "cf_clearance", headers["User-Agent"], proxyIpFromUrl(proxyUrl));
            console.warn(`[jiji-client] Cookie rejected by CF — invalidated stale cookie for ${targetDomain}`);
          } catch {}
        }
        return blockType;
      }
    }

    // Retryable: 429 (rate-limited) or 503 (temporarily unavailable) — for simplicity
    // here we just fail; the outer tryLiveApi handles retry via proxy rotation.
    if (resp.status === 429 || resp.status === 503) {
      recordFailure("error", `HTTP ${resp.status} (transient)`);
      return null;
    }

    if (!resp.ok) {
      recordFailure("error", `HTTP ${resp.status}`);
      return null;
    }

    const json = (await resp.json()) as T;
    recordLive();
    return json;
  } catch (e: any) {
    recordFailure(
      "error",
      e?.name === "AbortError" ? "timeout" : String(e?.message ?? "network error")
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Field mappers — handle Jiji's response shape variants
// ---------------------------------------------------------------------------

function num(v: any, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/[^\d-]/g, ""), 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function str(v: any, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

function dateOrNull(v: any): string | null {
  if (!v) return null;
  if (typeof v === "number") {
    // Unix timestamp (seconds or ms)
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function parseSeller(raw: any, marketId: string): JijiSeller | null {
  if (!raw || typeof raw !== "object") return null;
  const user = raw.user ?? raw.profile ?? raw.seller ?? raw;
  const numericUserId = num(user.id ?? user.user_id ?? user.numeric_id, 0);
  if (numericUserId === 0) return null;

  const id = `${marketId}-${numericUserId}`;
  return {
    id,
    marketId,
    numericUserId,
    username: str(user.name ?? user.username ?? user.full_name, "Unknown"),
    location: user.region?.name ?? user.city?.name ?? user.location ?? null,
    account_age_days: num(user.account_age_days ?? user.days_since_registered, 0),
    total_items: num(user.total_ads ?? user.total_listings, 0),
    adverts_count: num(user.adverts_count ?? user.adverts_active ?? user.total_items, 0),
    feedback_count: num(user.feedback_count ?? user.opinions_count, 0),
    rating: num(user.rating ?? user.score, 0),
    hide_phone: Boolean(user.hide_phone ?? user.hidePhone),
    phone: user.phone ?? user.user_phone ?? user.phone_number ?? user.contact ?? null,
    verified_badge: Boolean(user.verified ?? user.is_verified ?? user.badge),
  };
}

function parsePriceValuation(raw: any): {
  low: number | null;
  high: number | null;
  label: string | null;
  url: string | null;
} {
  const pv = raw.price_valuation ?? raw.valuation ?? raw.market_price;
  if (!pv || typeof pv !== "object") {
    return { low: null, high: null, label: null, url: null };
  }
  const label = pv.label ?? pv.text ?? null;
  const valueStr = pv.value ?? pv.range ?? "";
  const url = pv.url ?? null;

  // Parse formats Jiji uses:
  //   "KSh 362 K - 425 K"       → (362000, 425000)
  //   "KSh 362K - 425K"         → (362000, 425000)  ← no space before K
  //   "KSh 1,200,000 - 1,500,000" → (1200000, 1500000)
  //   "KSh 1.2M - 1.5M"         → (1200000, 1500000)  ← M suffix (million)
  //   "KSh 50,000"              → (50000, 50000)      ← single value
  let low: number | null = null;
  let high: number | null = null;
  if (typeof valueStr === "string") {
    const normalized = valueStr
      .replace(/KSh/gi, "")
      // Handle "1.2M" / "1.5M" (million) BEFORE handling K — replace with full integer
      .replace(/(\d[\d.]*?)\s*M\b/gi, (_, d) => String(Math.round(parseFloat(d) * 1_000_000)))
      // Handle "362K" (with or without space) — replace K with 000
      .replace(/(\d)\s*K\b/gi, "$1000")
      .replace(/,/g, "");
    const nums = normalized.match(/\d[\d\s]*\d|\d/g);
    if (nums && nums.length >= 2) {
      const a = parseInt(nums[0].replace(/\s/g, ""), 10);
      const b = parseInt(nums[1].replace(/\s/g, ""), 10);
      if (!isNaN(a) && !isNaN(b)) {
        low = Math.min(a, b);
        high = Math.max(a, b);
      }
    } else if (nums && nums.length === 1) {
      const a = parseInt(nums[0].replace(/\s/g, ""), 10);
      if (!isNaN(a)) {
        low = a;
        high = a;
      }
    }
  }
  return { low, high, label, url };
}

function parseListing(raw: any, marketId: string): JijiListing | null {
  if (!raw || typeof raw !== "object") return null;
  const guid = str(raw.id ?? raw.advert_id ?? raw.uuid ?? raw.guid, "");
  if (!guid) return null;

  const market = MARKETS.find((m) => m.id === marketId);
  const currency = market?.currency ?? "KES";

  const priceObj = raw.price_obj ?? raw.price ?? {};
  const price = num(typeof priceObj === "object" ? priceObj.price : priceObj, 0);

  const user = raw.user ?? raw.seller ?? raw.profile ?? {};
  const seller = parseSeller(user, marketId);
  if (!seller) return null;

  const imagesRaw: any[] = raw.images ?? raw.photos ?? raw.gallery ?? [];
  const images: JijiImage[] = imagesRaw.slice(0, 12).map((img: any) => {
    const url = typeof img === "string" ? img : str(img.url ?? img.path ?? img.src, "");
    return {
      url,
      width: num(img.width, 800),
      height: num(img.height, 600),
    };
  });

  const historyRaw: any[] = raw.price_history ?? raw.history ?? [];
  const priceHistory = historyRaw.map((h: any) => ({
    price: num(h.price ?? h.value, price),
    recorded_at: dateOrNull(h.recorded_at ?? h.date ?? h.at) ?? new Date().toISOString(),
  }));

  const dateCreated = dateOrNull(raw.date_created ?? raw.created_at);
  const dateEdited = dateOrNull(raw.date_edited ?? raw.edited_at);
  const dateModerated = dateOrNull(raw.date_moderated ?? raw.moderated_at);

  const valuation = parsePriceValuation(raw);

  let daysOnMarket = num(raw.days_on_market ?? raw.listing_age_days, 0);
  if (daysOnMarket === 0 && dateCreated) {
    daysOnMarket = Math.max(
      0,
      Math.floor((Date.now() - new Date(dateCreated).getTime()) / 86400000)
    );
  }

  return {
    id: `${marketId}-${guid}`,
    marketId,
    guid,
    title: str(raw.title ?? raw.advert_title ?? raw.name, "Untitled"),
    price,
    currency: typeof priceObj === "object" ? str(priceObj.currency, currency) : currency,
    category: str(raw.category?.slug ?? raw.category_slug ?? raw.category, "uncategorized"),
    category_id: raw.category?.id ?? raw.category_id ?? null,
    condition: str(raw.condition ?? raw.state, "new"),
    location: seller.location,
    url: raw.url ? str(raw.url) : `https://${market?.baseUrl.replace("https://", "")}/item/${guid}`,
    images,
    views: num(raw.count_views ?? raw.views ?? raw.views_count ?? raw.stats?.views, 0),
    fav_count: num(raw.fav_count ?? raw.favourites_count ?? raw.favorites_count, 0),
    days_on_market: daysOnMarket,
    date_created: dateCreated,
    date_edited: dateEdited,
    date_moderated: dateModerated,
    status: str(raw.status ?? "active", "active"),
    status_color: raw.status_color ?? null,
    sold_reported: Boolean(raw.sold_reported ?? raw.sold),
    can_make_an_offer: Boolean(raw.can_make_an_offer ?? raw.can_offer),
    abuse_reported: Boolean(raw.abuse_reported ?? raw.reported),
    is_boost: Boolean(raw.is_boost ?? raw.boosted),
    paid_info: raw.paid_info ?? null,
    available_tops_count: num(raw.available_tops_count, 0),
    price_valuation_low: valuation.low,
    price_valuation_high: valuation.high,
    price_valuation_label: valuation.label,
    price_valuation_url: valuation.url,
    seller,
    price_history: priceHistory,
  };
}

function findArray<T = any>(obj: any): T[] | null {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) return obj as T[];
  for (const key of ["adverts", "items", "data", "results", "list"]) {
    if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  for (const key of ["data", "result", "payload"]) {
    if (obj[key] && typeof obj[key] === "object") {
      const inner = findArray<T>(obj[key]);
      if (inner) return inner;
    }
  }
  return null;
}

function findObject(obj: any, keys: string[]): any | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === "object") return obj[k];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public client class
// ---------------------------------------------------------------------------

export class JijiClient {
  /**
   * Market census — one request returns all category IDs + live counts.
   * GET /api_web/v1/categories_counts.json
   */
  async getMarketCensus(marketId: MarketId): Promise<MarketCensusEntry[] | null> {
    const raw = await tryLiveApi<any>(marketId, "/categories_counts.json", {
      timeoutMs: 10000,
    });
    if (!raw) return null;

    // Response shape: { "3": 306000, "4": 72000, ... } OR { categories: [...] }
    const entries: MarketCensusEntry[] = [];
    if (Array.isArray(raw.categories)) {
      for (const c of raw.categories) {
        entries.push({
          catId: num(c.id, 0),
          slug: str(c.slug, ""),
          name: c.name,
          count: num(c.count ?? c.listings_count, 0),
        });
      }
    } else {
      // Plain object map: { "3-slug": 306000, ... } or { "3": 306000 }
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val !== "number") continue;
        const [idPart, slugPart] = key.split("-");
        const catId = parseInt(idPart, 10);
        if (isNaN(catId)) continue;
        entries.push({
          catId,
          slug: slugPart ?? "",
          count: val,
        });
      }
    }
    return entries.filter((e) => e.catId > 0);
  }

  /**
   * Category feed — first page of listings, follows next_url for pagination.
   * GET /api_web/v1/listing?category_type={id}-{slug}&ads_per_page=100
   */
  async getCategoryFeed(
    marketId: MarketId,
    catId: number,
    catSlug: string,
    opts: { maxPages?: number } = {}
  ): Promise<JijiSearchResult | null> {
    const maxPages = opts.maxPages ?? 1;
    const allItems: JijiListing[] = [];
    let nextUrl: string | null = null;
    let total = 0;
    let page = 1;

    for (let p = 1; p <= maxPages; p++) {
      const params: Record<string, string | number | undefined> = {
        category_type: `${catId}-${catSlug}`,
        ads_per_page: 100,
        webp: "true",
        page: p,
      };
      const raw = await tryLiveApi<any>(marketId, "/listing", { params });
      if (!raw) break;

      const arr = findArray<any>(raw);
      if (!arr || arr.length === 0) break;
      const items = arr
        .map((r) => parseListing(r, marketId))
        .filter((x): x is JijiListing => x !== null);
      allItems.push(...items);

      total = num(raw.total ?? raw.total_count ?? raw.count, allItems.length);
      nextUrl = raw.next_url ?? raw.next ?? null;
      page = p;
      if (items.length < 100) break; // last page
    }

    if (allItems.length === 0) return null;
    return { items: allItems, total, page, next_url: nextUrl };
  }

  /**
   * Seller inventory — every ad the seller has, with user_phone on each.
   * GET /api_web/v1/listing?user_id={numeric}&page=N
   */
  async getSellerInventory(
    marketId: MarketId,
    numericUserId: number,
    maxPages = 3
  ): Promise<JijiListing[] | null> {
    const all: JijiListing[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const raw = await tryLiveApi<any>(marketId, "/listing", {
        params: { user_id: numericUserId, page: p, ads_per_page: 50 },
      });
      if (!raw) break;
      const arr = findArray<any>(raw);
      if (!arr || arr.length === 0) break;
      const items = arr
        .map((r) => parseListing(r, marketId))
        .filter((x): x is JijiListing => x !== null);
      all.push(...items);
      if (items.length < 50) break;
    }
    return all.length > 0 ? all : null;
  }

  /**
   * Full item detail — moderation history, abuse flags, paid info.
   * GET /api_web/v1/item/{guid}/data.json
   */
  async getItemDetail(marketId: MarketId, guid: string): Promise<JijiListing | null> {
    const raw = await tryLiveApi<any>(marketId, `/item/${guid}/data.json`);
    if (!raw) return null;
    const advert = findObject(raw, ["advert", "item", "data"]) ?? raw;
    return parseListing(advert, marketId);
  }

  /**
   * Seller profile — adverts_count, feedback_count, dealer detection.
   * GET /api_web/v1/seller/{id}/data.json
   */
  async getSeller(marketId: MarketId, numericUserId: number): Promise<JijiSeller | null> {
    const raw = await tryLiveApi<any>(marketId, `/seller/${numericUserId}/data.json`);
    if (!raw) return null;
    return parseSeller(raw, marketId);
  }

  /**
   * Seller reviews/opinions — test endpoint, may or may not exist.
   * GET /api_web/v1/opinions/{id}.json
   */
  async getOpinions(
    marketId: MarketId,
    numericUserId: number
  ): Promise<any | null> {
    const raw = await tryLiveApi<any>(marketId, `/opinions/${numericUserId}.json`);
    return raw;
  }

  /**
   * Filtered search — exact query + price filters + sort.
   *
   * Recon-verified endpoint: /api_web/v1/listing?query={q}&page=N&price_min=X&price_max=Y&sort=...
   * (NOT /search — that endpoint has zero Wayback captures and returns 404)
   */
  async search(
    marketId: MarketId,
    opts: {
      q: string;
      minPrice?: number;
      maxPrice?: number;
      sort?: "new" | "price_asc" | "price_desc" | "relevance";
      page?: number;
    }
  ): Promise<JijiSearchResult | null> {
    const sortMap = {
      new: "created_at:desc",
      price_asc: "price:asc",
      price_desc: "price:desc",
      relevance: "relevance",
    };
    const raw = await tryLiveApi<any>(marketId, "/listing", {
      params: {
        query: opts.q,
        price_min: opts.minPrice,
        price_max: opts.maxPrice,
        sort: sortMap[opts.sort ?? "relevance"],
        page: opts.page ?? 1,
        ads_per_page: 50,
        webp: "true",
      },
    });
    if (!raw) return null;
    const arr = findArray<any>(raw);
    if (!arr) return null;
    const items = arr
      .map((r) => parseListing(r, marketId))
      .filter((x): x is JijiListing => x !== null);
    if (items.length === 0) return null;
    return {
      items,
      total: num(raw.total ?? raw.total_count, items.length),
      page: opts.page ?? 1,
      next_url: raw.next_url ?? raw.next ?? null,
    };
  }
}

/**
 * Default singleton. Live-only — no synthetic fallback.
 */
export const jiji = new JijiClient();

/**
 * Ensure a Market row exists in the DB.
 */
export async function ensureMarket(marketId: MarketId): Promise<void> {
  const m = MARKETS.find((x) => x.id === marketId);
  if (!m) return;
  await db.market.upsert({
    where: { id: marketId },
    create: { id: marketId, name: m.name, baseUrl: m.baseUrl },
    update: {},
  });
}

/**
 * Persist census data into Category table.
 */
export async function persistCensus(
  marketId: MarketId,
  entries: MarketCensusEntry[]
): Promise<number> {
  await ensureMarket(marketId);
  let persisted = 0;
  for (const e of entries) {
    if (e.catId === 0 || !e.slug) continue;
    await db.category.upsert({
      where: { marketId_catId: { marketId, catId: e.catId } },
      create: {
        id: `${marketId}-${e.catId}`,
        marketId,
        catId: e.catId,
        slug: e.slug,
        name: e.name,
        listingCount: e.count,
        lastSeenAt: new Date(),
      },
      update: {
        slug: e.slug,
        name: e.name,
        listingCount: e.count,
        lastSeenAt: new Date(),
      },
    });
    persisted++;
  }
  return persisted;
}
