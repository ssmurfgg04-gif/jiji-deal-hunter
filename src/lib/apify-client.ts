/**
 * Apify Client — Tier 2 Cloudflare bypass (hosted, FREE $5/mo credit).
 *
 * Uses the `logiover/jiji-africa-scraper` actor which:
 *   - Reads Jiji's JSON listing endpoints (same as our jiji-client.ts)
 *   - Routes through residential IPs inside the target country (CF bypass!)
 *   - Supports all 5 markets: NG, KE, GH, UG, TZ
 *   - Pays per result (~$0.004 per listing on FREE tier)
 *
 * Apify FREE plan includes:
 *   - $5/mo credit (~1250 results/mo at $0.004 each)
 *   - 1,000,000 unblocker units (for /proxy-unblocker API)
 *   - 5 datacenter proxies + residential proxy access
 *
 * Two modes:
 *   1. runJijiScraper() — full actor run, returns dataset of listings
 *   2. fetchJsonViaApifyProxy() — raw HTTP via Apify residential proxy
 *      (lighter weight, but doesn't get CF challenge solved automatically)
 *
 * Per docs/CLOUDFLARE_BYPASS_RESEARCH.md section "Tier 4" (now Tier 2
 * after Spider.cloud was found to require paid credits).
 */

import { db } from "./db";

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_USER_ID = process.env.APIFY_USER_ID;
const APIFY_TIMEOUT_MS = parseInt(process.env.APIFY_TIMEOUT_MS ?? "120000", 10);

// Actor: logiover/jiji-africa-scraper
// Covers all 5 Jiji markets (NG, KE, GH, UG, TZ)
const JIJI_AFRICA_ACTOR_ID = "logiover~jiji-africa-scraper";

// Apify residential proxy password (from user profile)
// Used for raw proxy mode (not actor runs)
const APIFY_PROXY_PASSWORD = process.env.APIFY_PROXY_PASSWORD ?? "";

export interface ApifyJijiInput {
  market: "ng" | "ke" | "gh" | "ug" | "tz";
  categorySlug?: string; // e.g. "cars", "real-estate", "electronics"
  maxResults?: number; // default 100
  startPage?: number;
  // Actor handles proxy config; we just request residential
  proxyConfiguration?: {
    useApifyProxy: boolean;
    apifyProxyGroups: string[]; // ["RESIDENTIAL"]
  };
}

export interface ApifyJijiListing {
  // Output schema per actor README + actual dataset inspection
  advertId?: string;
  guid?: string;
  url?: string;
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  priceLabel?: string;
  pricePeriod?: string | null;
  category?: string;
  categorySlug?: string;
  categoryId?: number;
  condition?: string;
  attributes?: Record<string, any>;
  attributesText?: string;
  region?: string;
  regionName?: string;
  regionParent?: string;
  regionSlug?: string;
  sellerName?: string | null;
  sellerRating?: number | null;
  sellerAvatar?: string | null;
  sellerId?: string;
  isVerifiedId?: boolean;
  isPopular?: boolean | null;
  isInspected?: boolean;
  isPromoted?: boolean;
  promotionPackage?: string | null;
  canViewContacts?: boolean;
  imageCount?: number;
  mainImage?: string;
  imageUrls?: string; // comma-separated string
  status?: string;
  isJobAd?: boolean;
  country?: string;
  source?: string;
  scrapedAt?: string;
}

export interface ApifyRunResult {
  ok: boolean;
  runId?: string;
  datasetId?: string;
  listings?: ApifyJijiListing[];
  itemCount?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export function isApifyConfigured(): boolean {
  return Boolean(APIFY_API_TOKEN);
}

/**
 * Kick off a Jiji Africa scraper run.
 * Polls until run finishes, then fetches dataset.
 *
 * Usage:
 *   const result = await runJijiScraper({
 *     market: "ke",
 *     categorySlug: "cars",
 *     maxResults: 50,
 *   });
 *   if (result.ok) console.log(result.listings);
 */
export async function runJijiScraper(
  input: ApifyJijiInput
): Promise<ApifyRunResult> {
  if (!APIFY_API_TOKEN) {
    return { ok: false, error: "APIFY_API_TOKEN not set" };
  }

  const startedAt = Date.now();
  const fullInput: ApifyJijiInput = {
    maxResults: 100,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
    },
    ...input,
  };

  try {
    // Step 1: Start the run
    const startResp = await fetch(
      `https://api.apify.com/v2/acts/${JIJI_AFRICA_ACTOR_ID}/runs?token=${APIFY_API_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fullInput),
      }
    );

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => "");
      return {
        ok: false,
        error: `Apify start HTTP ${startResp.status}: ${text.slice(0, 200)}`,
      };
    }

    const startJson: any = await startResp.json();
    const runId = startJson.data.id;
    const datasetId = startJson.data.defaultDatasetId;
    console.log(
      `[apify] Run ${runId} started for market=${input.market} ` +
        `category=${input.categorySlug ?? "(all)"} maxResults=${fullInput.maxResults}`
    );

    // Step 2: Poll for completion (5s intervals, up to APIFY_TIMEOUT_MS)
    while (Date.now() - startedAt < APIFY_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 5000));

      const pollResp = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_TOKEN}`
      );
      if (!pollResp.ok) continue;

      const pollJson: any = await pollResp.json();
      const status = pollJson.data.status;
      const stats = pollJson.data.stats || {};

      if (status === "SUCCEEDED") {
        console.log(
          `[apify] Run ${runId} SUCCEEDED — totalResults=${stats.totalResults ?? 0} ` +
            `duration=${stats.runTimeSecs?.toFixed(1) ?? 0}s ` +
            `computeUnits=${stats.computeUnits?.toFixed(4) ?? 0}`
        );
        // Step 3: Fetch dataset
        const listings = await fetchDataset(datasetId);
        return {
          ok: true,
          runId,
          datasetId,
          listings,
          itemCount: listings.length,
          durationMs: Date.now() - startedAt,
        };
      }

      if (status === "FAILED" || status === "TIMED-OUT" || status === "ABORTED") {
        return {
          ok: false,
          runId,
          error: `Apify run ${status}: ${pollJson.data.exitCode ?? "unknown exit"}`,
          durationMs: Date.now() - startedAt,
        };
      }

      // Still RUNNING — log progress
      console.log(
        `[apify] Run ${runId} RUNNING — ${stats.totalResults ?? 0} results so far, ` +
          `${stats.runTimeSecs?.toFixed(1) ?? 0}s elapsed`
      );
    }

    return {
      ok: false,
      runId,
      error: "Apify run timeout",
      durationMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message ?? "network error",
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Fetch all items from an Apify dataset.
 */
async function fetchDataset(datasetId: string): Promise<ApifyJijiListing[]> {
  if (!APIFY_API_TOKEN) return [];

  const all: ApifyJijiListing[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}&limit=${limit}&offset=${offset}&clean=true`;
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`[apify] Dataset fetch HTTP ${r.status}`);
      break;
    }
    const items: any[] = await r.json();
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break; // last page
    offset += limit;
  }

  return all;
}

/**
 * Lightweight mode: use Apify's residential proxy as a direct HTTP proxy
 * to fetch a single URL. Bypasses CF when residential IP isn't blocked.
 *
 * This is much cheaper than running the full actor — no compute units,
 * just proxy traffic. But it doesn't solve Turnstile challenges; it relies
 * on residential IPs not being challenged in the first place.
 *
 * Usage:
 *   const json = await fetchJsonViaApifyProxy("https://jiji.co.ke/api_web/v1/categories_counts.json");
 */
export async function fetchJsonViaApifyProxy<T = any>(
  url: string,
  options: { group?: string; country?: string } = {}
): Promise<T | null> {
  if (!APIFY_PROXY_PASSWORD) {
    console.warn("[apify-proxy] APIFY_PROXY_PASSWORD not set");
    return null;
  }

  const group = options.group ?? "RESIDENTIAL";
  const country = options.country ?? "KE"; // default to Kenya for jiji.co.ke
  const proxyUrl = `http://auto:${APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;
  // Apify proxy uses session ID + country via username
  // Format: auto:<password> OR sessions-<session_id>,<group>:<password>
  const username = `auto,${group}-${country}`;
  const fullProxy = `http://${username}:${APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);

    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // @ts-ignore — Node 22+ supports proxy in fetch init
      proxy: fullProxy,
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!r.ok) {
      console.warn(`[apify-proxy] HTTP ${r.status} via ${group}-${country}`);
      return null;
    }

    const json = (await r.json()) as T;
    return json;
  } catch (e: any) {
    console.warn(`[apify-proxy] Error:`, e?.message);
    return null;
  }
}

/**
 * Get Apify account usage info (remaining credits etc).
 * Useful for the /api/health endpoint.
 */
export async function getApifyUsage(): Promise<{
  ok: boolean;
  plan?: string;
  monthlyUsageCreditsUsd?: number;
  maxMonthlyUsageUsd?: number;
  error?: string;
}> {
  if (!APIFY_API_TOKEN || !APIFY_USER_ID) {
    return { ok: false, error: "APIFY_API_TOKEN or APIFY_USER_ID not set" };
  }

  try {
    const r = await fetch(
      `https://api.apify.com/v2/users/${APIFY_USER_ID}?token=${APIFY_API_TOKEN}`
    );
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}` };
    }
    const json: any = await r.json();
    const plan = json.data?.plan ?? {};
    return {
      ok: true,
      plan: plan.id,
      monthlyUsageCreditsUsd: plan.monthlyUsageCreditsUsd,
      maxMonthlyUsageUsd: plan.maxMonthlyUsageUsd,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}
