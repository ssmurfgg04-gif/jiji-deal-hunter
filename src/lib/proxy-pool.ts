/**
 * Proxy Pool — target-tested validation.
 *
 * Adapted from the Chinese JD.com monitor (8998663 / Price-monitor): test
 * proxies against the ACTUAL TARGET SITE, not against httpbin.org/ip. A proxy
 * that "works" against httpbin may still be blocked by Cloudflare's anti-bot.
 *
 * The pool runs concurrent validation (Promise.all with a concurrency cap),
 * keeps only proxies that return 200 from the target's health-check endpoint,
 * and rotates them round-robin during collection.
 *
 * Stored in the ProxyPool table so results persist across runs.
 */

import { db } from "./db";

const TARGET_HEALTH_URL = "https://jiji.co.ke/api_web/v1/search?q=test&page=1";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 10;

export interface ProxyValidationResult {
  url: string;
  working: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Validate a single proxy by hitting the target's health endpoint.
 */
async function validateOne(
  proxyUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProxyValidationResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(TARGET_HEALTH_URL, {
      proxy: proxyUrl as any, // fetch proxy option (Node 22+); no-op in older runtimes
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    if (resp.ok) {
      return { url: proxyUrl, working: true, latencyMs: Date.now() - start };
    }
    return {
      url: proxyUrl,
      working: false,
      latencyMs: Date.now() - start,
      error: `HTTP ${resp.status}`,
    };
  } catch (e: any) {
    clearTimeout(timer);
    return {
      url: proxyUrl,
      working: false,
      latencyMs: Date.now() - start,
      error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? "unknown"),
    };
  }
}

/**
 * Run a concurrent validation sweep against a list of proxy URLs.
 * Returns the working subset.
 */
export async function validateProxies(
  proxyUrls: string[],
  concurrency = DEFAULT_CONCURRENCY
): Promise<ProxyValidationResult[]> {
  const results: ProxyValidationResult[] = [];
  const queue = [...proxyUrls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      const result = await validateOne(url);
      results.push(result);
      // Persist to DB
      await db.proxyPool.upsert({
        where: { url },
        create: {
          url,
          isWorking: result.working,
          latencyMs: result.latencyMs,
          lastTestedAt: new Date(),
          failCount: result.working ? 0 : 1,
        },
        update: {
          isWorking: result.working,
          latencyMs: result.latencyMs,
          lastTestedAt: new Date(),
          failCount: result.working ? 0 : { increment: 1 },
        },
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Pick a working proxy from the pool (round-robin by lowest latency).
 */
export async function pickProxy(): Promise<string | null> {
  const working = await db.proxyPool.findMany({
    where: { isWorking: true },
    orderBy: [{ latencyMs: "asc" }],
    take: 1,
  });
  return working[0]?.url ?? null;
}

/**
 * Seed the proxy pool with a starter list (operator-provided URLs).
 * Idempotent — existing proxies are skipped.
 */
export async function seedProxyPool(urls: string[]): Promise<number> {
  let added = 0;
  for (const url of urls) {
    try {
      await db.proxyPool.upsert({
        where: { url },
        create: { url, isWorking: false },
        update: {},
      });
      added++;
    } catch {
      // ignore duplicates / malformed
    }
  }
  return added;
}
