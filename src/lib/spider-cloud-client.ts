/**
 * Spider.cloud Client — Tier 3 Cloudflare bypass (hosted, paid).
 *
 * Per https://spider.cloud/agent-skill/SKILL.md:
 *   - POST /scrape — one page, basic HTTP fetch (no JS, no CF bypass)
 *   - POST /unblocker — fetch one page through Spider's anti-bot bypass
 *                       (proxy rotation, fingerprinting, JS challenge solving)
 *
 * For CF-protected sites like jiji.co.ke, we MUST use /unblocker.
 *
 * Pricing: $1/GB + $0.001/CPU-min. Requires paid credits (free tier doesn't
 * cover /unblocker — verified: returns 402 "credits_required").
 *
 * Auth: Bearer SPIDER_API_KEY env var.
 */

const SPIDER_API_URL = "https://api.spider.cloud";
const SPIDER_API_KEY = process.env.SPIDER_API_KEY;
const SPIDER_TIMEOUT_MS = parseInt(process.env.SPIDER_TIMEOUT_MS ?? "90000", 10);

export interface SpiderCloudResult {
  ok: boolean;
  content?: string;
  status?: number;
  url?: string;
  error?: string;
  cost?: number;
  durationMs?: number;
}

export async function isSpiderCloudConfigured(): Promise<boolean> {
  // Always "configured" — no-key endpoint works (rate-limited)
  return true;
}

/**
 * Scrape a URL via Spider.cloud.
 * Returns the body as markdown/html/text depending on returnFormat.
 *
 * Usage:
 *   const result = await scrapeViaSpiderCloud(
 *     "https://jiji.co.ke/api_web/v1/categories_counts.json",
 *     { returnFormat: "text" }
 *   );
 *   if (result.ok && result.content) {
 *     const json = JSON.parse(result.content);
 *   }
 */
export async function scrapeViaSpiderCloud(
  url: string,
  options: { returnFormat?: "markdown" | "html" | "text"; request?: "http" | "browser" | "smart" } = {}
): Promise<SpiderCloudResult> {
  // Per Spider.cloud SKILL.md: /unblocker is the endpoint for bot-walled sites.
  // It handles proxy rotation + fingerprinting + JS challenge solving.
  // /scrape is for plain pages only.
  const endpoint = "/unblocker";
  const returnFormat = options.returnFormat ?? "markdown";
  // /unblocker handles request mode internally — but if specified, "browser"
  // is preferred for JS-heavy CF challenges.
  const request = options.request ?? "browser";
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), SPIDER_TIMEOUT_MS);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SPIDER_API_KEY) {
      headers["Authorization"] = `Bearer ${SPIDER_API_KEY}`;
    }

    const r = await fetch(`${SPIDER_API_URL}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, return_format: returnFormat, request }),
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `Spider.cloud HTTP ${r.status}: ${text.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const json: any = await r.json();

    // Spider.cloud returns array of results (one per URL)
    const first = Array.isArray(json) ? json[0] : json;
    if (!first) {
      return {
        ok: false,
        error: "Spider.cloud returned empty response",
        durationMs: Date.now() - startedAt,
      };
    }

    if (first.error || (first.status && first.status >= 400)) {
      return {
        ok: false,
        status: first.status,
        url: first.url,
        error: first.error ?? `HTTP ${first.status}`,
        cost: first.costs?.total_cost,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      content: first.content ?? "",
      status: first.status,
      url: first.url,
      cost: first.costs?.total_cost,
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
 * Convenience: scrape a jiji.co.ke API endpoint via Spider.cloud and parse JSON.
 * Spider.cloud returns text, so we ask for raw text and JSON.parse it.
 *
 * Returns null on any failure (does not throw).
 */
export async function fetchJsonViaSpiderCloud<T = any>(
  url: string
): Promise<T | null> {
  const result = await scrapeViaSpiderCloud(url, { returnFormat: "text" });
  if (!result.ok || !result.content) {
    console.warn(
      `[spider-cloud] Failed: ${result.error} ` +
        `(cost=$${result.cost?.toFixed(6) ?? "?"}, ${result.durationMs}ms)`
    );
    return null;
  }
  try {
    return JSON.parse(result.content) as T;
  } catch (e: any) {
    console.warn(
      `[spider-cloud] JSON parse failed:`,
      e?.message,
      `(content was ${result.content.length}b, first 200: ${result.content.slice(0, 200)})`
    );
    return null;
  }
}
