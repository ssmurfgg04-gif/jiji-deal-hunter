/**
 * CookieVault — persists Cloudflare bypass cookies (cf_clearance, __cf_bm).
 *
 * Cloudflare cookies are bound to (domain, userAgent, proxyIp) — CF re-validates
 * all three on each request. We persist them together so we can reuse a cookie
 * across multiple API calls within its ~30-minute validity window.
 *
 * Per WAF_BYPASS_RESEARCH.md section 6.2: CookieVault table allows us to:
 *   1. Cache a successful CapSolver/stealth-browser solve for 30 minutes
 *   2. Avoid re-solving Turnstile on every request (saves $$ on CapSolver)
 *   3. Share cookies across multiple collector processes
 *
 * Usage:
 *   // Save a cookie obtained via CapSolver or stealth browser
 *   await saveCookie({
 *     domain: "jiji.co.ke",
 *     name: "cf_clearance",
 *     value: "abc123...",
 *     userAgent: "Mozilla/5.0 ...",
 *     source: "capsolver",
 *     ttlMinutes: 30,
 *   });
 *
 *   // Reuse it for subsequent requests
 *   const cookie = await getValidCookie("jiji.co.ke", "cf_clearance", userAgent);
 *   if (cookie) {
 *     headers["Cookie"] = `cf_clearance=${cookie.value}`;
 *   }
 */

import { db } from "./db";

export interface SaveCookieInput {
  domain: string;
  name: string; // "cf_clearance" | "__cf_bm"
  value: string;
  userAgent: string;
  proxyIp?: string | null;
  source?: string; // "capsolver" | "nodriver" | "manual" | "residential-proxy"
  ttlMinutes?: number; // default 30
}

export interface VaultedCookie {
  id: number;
  domain: string;
  name: string;
  value: string;
  userAgent: string;
  proxyIp: string | null;
  source: string;
  expiresAt: Date;
  useCount: number;
}

/**
 * Save (or upsert) a cookie in the vault.
 * If a cookie with the same (domain, name, userAgent, proxyIp) exists, update its value
 * and expiry; otherwise insert a new row.
 */
export async function saveCookie(input: SaveCookieInput): Promise<VaultedCookie> {
  const ttlMs = (input.ttlMinutes ?? 30) * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const proxyIp = input.proxyIp ?? null;
  const source = input.source ?? "unknown";

  // Upsert by unique constraint (domain, name, userAgent, proxyIp)
  const existing = await db.cookieVault.findFirst({
    where: {
      domain: input.domain,
      name: input.name,
      userAgent: input.userAgent,
      proxyIp,
    },
  });

  if (existing) {
    const updated = await db.cookieVault.update({
      where: { id: existing.id },
      data: {
        value: input.value,
        source,
        expiresAt,
        isValid: true,
        useCount: 0, // reset use count on refresh
      },
    });
    return updated as VaultedCookie;
  }

  const created = await db.cookieVault.create({
    data: {
      domain: input.domain,
      name: input.name,
      value: input.value,
      userAgent: input.userAgent,
      proxyIp,
      source,
      expiresAt,
      isValid: true,
    },
  });
  return created as VaultedCookie;
}

/**
 * Get a valid (non-expired) cookie for the given domain+name+UA.
 * Returns null if no valid cookie exists.
 * Also bumps useCount + lastUsedAt for observability.
 */
export async function getValidCookie(
  domain: string,
  name: string,
  userAgent: string,
  proxyIp?: string | null
): Promise<VaultedCookie | null> {
  const now = new Date();
  const cookie = await db.cookieVault.findFirst({
    where: {
      domain,
      name,
      userAgent,
      proxyIp: proxyIp ?? null,
      isValid: true,
      expiresAt: { gt: now },
    },
    orderBy: { expiresAt: "desc" }, // pick the one with the longest remaining TTL
  });

  if (!cookie) return null;

  // Bump use count + last used (best-effort, don't block on failure)
  db.cookieVault
    .update({
      where: { id: cookie.id },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: now,
      },
    })
    .catch(() => null);

  return cookie as VaultedCookie;
}

/**
 * Mark a cookie as invalid (e.g. if we get a 403 using it — CF invalidated it early).
 * This prevents re-using a stale cookie on subsequent requests.
 */
export async function invalidateCookie(
  domain: string,
  name: string,
  userAgent: string,
  proxyIp?: string | null
): Promise<void> {
  await db.cookieVault
    .updateMany({
      where: {
        domain,
        name,
        userAgent,
        proxyIp: proxyIp ?? null,
      },
      data: { isValid: false },
    })
    .catch(() => null);
}

/**
 * Garbage-collect expired cookies. Run periodically (e.g. once per hour) to
 * prevent the table from growing unbounded.
 */
export async function purgeExpiredCookies(): Promise<{ deleted: number }> {
  const now = new Date();
  const result = await db.cookieVault.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { isValid: false, createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return { deleted: result.count };
}

/**
 * Format a cookie vault entry as a Cookie header value.
 * Example: "cf_clearance=abc123; __cf_bm=xyz789"
 */
export function formatCookieHeader(cookies: VaultedCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Get ALL valid cookies for a domain (e.g. both cf_clearance AND __cf_bm).
 * Useful when CF requires multiple cookies to be present.
 */
export async function getAllValidCookies(
  domain: string,
  userAgent: string,
  proxyIp?: string | null
): Promise<VaultedCookie[]> {
  const now = new Date();
  const cookies = await db.cookieVault.findMany({
    where: {
      domain,
      userAgent,
      proxyIp: proxyIp ?? null,
      isValid: true,
      expiresAt: { gt: now },
    },
    orderBy: { expiresAt: "desc" },
  });
  return cookies as VaultedCookie[];
}
