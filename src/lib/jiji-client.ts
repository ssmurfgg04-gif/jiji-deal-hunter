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
 * Pacing: 1-2 seconds between requests, single-threaded. No proxy needed for
 * direct API calls — Cloudflare challenge only triggers on aggressive HTML scraping.
 *
 * IMPORTANT: This client does NOT silently fall back to synthetic data. If a live
 * call fails, it returns null and the caller decides how to handle the gap
 * (typically by logging to CollectionRun.log and continuing).
 */

import { db } from "./db";

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

export const liveApiStatus: LiveApiStatus = {
  lastMode: "live",
  lastCheckedAt: null,
  lastError: null,
  liveSuccessCount: 0,
  failureCount: 0,
};

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://jiji.co.ke/",
  "X-Requested-With": "XMLHttpRequest",
};

const REQUEST_DELAY_MS = 1200; // 1.2s pacing between requests, single-threaded
let lastRequestAt = 0;

async function pacedDelay() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function recordLive() {
  liveApiStatus.lastMode = "live";
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = null;
  liveApiStatus.liveSuccessCount++;
}

function recordFailure(mode: "blocked" | "error", reason: string) {
  liveApiStatus.lastMode = mode;
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = reason;
  liveApiStatus.failureCount++;
}

/**
 * Core fetch with timeout + Cloudflare detection. Returns null on any failure
 * (does NOT throw — the caller decides how to handle).
 */
async function tryLiveApi<T>(
  marketId: string,
  path: string,
  opts: { timeoutMs?: number; params?: Record<string, string | number | undefined> } = {}
): Promise<T | null> {
  const market = MARKETS.find((m) => m.id === marketId);
  if (!market) return null;

  await pacedDelay();

  const url = new URL(`${market.baseUrl}/api_web/v1${path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    const resp = await fetch(url.toString(), {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    // Cloudflare challenge pages return 403 with HTML body
    if (resp.status === 403) {
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) {
        recordFailure("blocked", "Cloudflare JS challenge (403 + HTML)");
        return null;
      }
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

  // Compute days on market if we have date_created
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
   * GET /api_web/v1/search?q=...&min_price=...&max_price=...&sort=...&page=1
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
      new: "new",
      price_asc: "price:asc",
      price_desc: "price:desc",
      relevance: "relevance",
    };
    const raw = await tryLiveApi<any>(marketId, "/search", {
      params: {
        q: opts.q,
        min_price: opts.minPrice,
        max_price: opts.maxPrice,
        sort: sortMap[opts.sort ?? "relevance"],
        page: opts.page ?? 1,
        ads_per_page: 50,
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
