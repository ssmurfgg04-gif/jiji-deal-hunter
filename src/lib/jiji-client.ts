/**
 * Jiji API Client — live + fallback
 *
 * Pipeline:
 *   1. Try the live `api_web/v1/*` endpoint with a short timeout.
 *   2. If reachable, parse the response — Jiji wraps search results in
 *      `{ adverts: [...] }` or `{ data: { adverts: [...] } }`; we handle
 *      the common shapes flexibly.
 *   3. If unreachable (sandbox, network block, Cloudflare challenge), fall
 *      back to the synthetic generator so the dashboard always has data.
 *
 * A liveApiStatus object tracks which mode the last call used, so the UI
 * can surface a "LIVE / SAMPLE" badge in the header.
 */

const JIJI_BASE = "https://jiji.co.ke";
const API_PREFIX = "/api_web/v1";

export interface JijiSeller {
  id: string;
  username: string;
  location: string | null;
  account_age_days: number;
  total_items: number;
  rating: number;
  hide_phone: boolean;
  phone: string | null;
  verified_badge: boolean;
}

export interface JijiImage {
  url: string;
  width: number;
  height: number;
}

export interface JijiListing {
  id: string;
  title: string;
  price: number;
  currency: string;
  category: string;
  condition: string;
  location: string | null;
  url: string | null;
  images: JijiImage[];
  views: number;
  days_on_market: number;
  seller: JijiSeller;
  price_history: { price: number; recorded_at: string }[];
}

export interface JijiSearchResult {
  items: JijiListing[];
  total: number;
  page: number;
}

export interface LiveApiStatus {
  lastMode: "live" | "sample";
  lastCheckedAt: string | null;
  lastError: string | null;
  liveSuccessCount: number;
  sampleFallbackCount: number;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: JIJI_BASE,
  "X-Requested-With": "XMLHttpRequest",
};

/**
 * Live API status singleton — read by /api/status and surfaced in the dashboard.
 */
export const liveApiStatus: LiveApiStatus = {
  lastMode: "sample",
  lastCheckedAt: null,
  lastError: null,
  liveSuccessCount: 0,
  sampleFallbackCount: 0,
};

function recordLive() {
  liveApiStatus.lastMode = "live";
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = null;
  liveApiStatus.liveSuccessCount++;
}

function recordSample(reason: string) {
  liveApiStatus.lastMode = "sample";
  liveApiStatus.lastCheckedAt = new Date().toISOString();
  liveApiStatus.lastError = reason;
  liveApiStatus.sampleFallbackCount++;
}

/**
 * Try a live API call. Returns null on any failure so the caller can fall back.
 */
async function tryLiveApi<T>(path: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${JIJI_BASE}${API_PREFIX}${path}`, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      recordSample(`HTTP ${resp.status}`);
      return null;
    }
    const json = (await resp.json()) as T;
    recordLive();
    return json;
  } catch (e: any) {
    recordSample(e?.name === "AbortError" ? "timeout" : String(e?.message ?? "network error"));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Response shape normalization
// ---------------------------------------------------------------------------
// Jiji's real API typically wraps responses in one of these shapes:
//   { status: "ok", adverts: [...] }           (search results)
//   { status: "ok", data: { adverts: [...] } } (alt search wrapper)
//   { status: "ok", advert: {...} }            (single item)
//   { status: "ok", profile: {...} }           (seller profile)
// We probe each common location and pick whichever holds an array/object.
// ---------------------------------------------------------------------------

function findArray<T = any>(obj: any): T[] | null {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) return obj as T[];
  for (const key of ["adverts", "items", "data", "results", "list"]) {
    if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  // One more level deep
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

function num(v: any, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/[^\d]/g, ""), 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function str(v: any, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

/**
 * Map a raw Jiji advert object → our normalized JijiListing shape.
 * Handles the field name variants Jiji uses (title, advert_title, price_obj, etc).
 */
function mapAdvert(raw: any): JijiListing | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id ?? raw.advert_id ?? raw.uuid, "");
  if (!id) return null;

  const title = str(raw.title ?? raw.advert_title ?? raw.name, "Untitled");
  const priceObj = raw.price_obj ?? raw.price ?? {};
  const price = num(typeof priceObj === "object" ? priceObj.price : priceObj, 0);
  const currency =
    typeof priceObj === "object" ? str(priceObj.currency ?? "KES", "KES") : "KES";

  const user = raw.user ?? raw.seller ?? raw.profile ?? {};
  const sellerId = str(user.id ?? user.user_id ?? user.uuid, `seller-${id}`);
  const seller: JijiSeller = {
    id: sellerId,
    username: str(user.name ?? user.username ?? user.full_name, "Unknown"),
    location: user.region?.name ?? user.city?.name ?? user.location ?? null,
    account_age_days: num(user.account_age_days ?? user.days_since_registered, 0),
    total_items: num(user.total_ads ?? user.total_listings ?? user.listings_count, 0),
    rating: num(user.rating ?? user.score, 0),
    hide_phone: Boolean(user.hide_phone ?? user.hidePhone),
    phone: user.phone ?? user.phone_number ?? user.contact ?? null,
    verified_badge: Boolean(user.verified ?? user.is_verified ?? user.badge),
  };

  const imagesRaw: any[] = raw.images ?? raw.photos ?? raw.gallery ?? [];
  const images: JijiImage[] = imagesRaw.slice(0, 12).map((img: any) => {
    const url = typeof img === "string" ? img : str(img.url ?? img.path ?? img.src, "");
    return { url, width: num(img.width, 800), height: num(img.height, 600) };
  });

  const historyRaw: any[] = raw.price_history ?? raw.history ?? [];
  const priceHistory = historyRaw.map((h: any) => ({
    price: num(h.price ?? h.value, price),
    recorded_at: str(h.recorded_at ?? h.date ?? h.at, new Date().toISOString()),
  }));

  return {
    id,
    title,
    price,
    currency,
    category: str(raw.category?.slug ?? raw.category_slug ?? raw.category, "uncategorized"),
    condition: str(raw.condition ?? raw.state, "new"),
    location: seller.location,
    url: raw.url ? str(raw.url) : `${JIJI_BASE}/item/${id}`,
    images,
    views: num(raw.views ?? raw.views_count ?? raw.stats?.views, 0),
    days_on_market: num(raw.days_on_market ?? raw.listing_age_days, 0),
    seller,
    price_history: priceHistory,
  };
}

/**
 * Normalize a raw search response into our JijiSearchResult.
 */
function normalizeSearch(raw: any, page: number): JijiSearchResult | null {
  const arr = findArray<any>(raw);
  if (!arr) return null;
  const items = arr
    .map(mapAdvert)
    .filter((x): x is JijiListing => x !== null);
  if (items.length === 0) return null;
  const total = num(
    raw.total ?? raw.total_count ?? raw.count ?? raw.data?.total ?? items.length,
    items.length
  );
  return { items, total, page };
}

/**
 * Normalize a raw single-item response.
 */
function normalizeItem(raw: any, idHint: string): JijiListing | null {
  const advert = findObject(raw, ["advert", "item", "data"]) ?? raw;
  return mapAdvert(advert) ?? sampleListing(idHint);
}

/**
 * Normalize a raw seller profile response.
 */
function normalizeSeller(raw: any, idHint: string): JijiSeller | null {
  const profile = findObject(raw, ["profile", "seller", "data", "user"]) ?? raw;
  if (!profile || typeof profile !== "object") return null;
  const seller: JijiSeller = {
    id: str(profile.id ?? profile.user_id ?? idHint, idHint),
    username: str(profile.name ?? profile.username ?? profile.full_name, "Unknown"),
    location: profile.region?.name ?? profile.city?.name ?? profile.location ?? null,
    account_age_days: num(profile.account_age_days ?? profile.days_since_registered, 0),
    total_items: num(profile.total_ads ?? profile.total_listings, 0),
    rating: num(profile.rating ?? profile.score, 0),
    hide_phone: Boolean(profile.hide_phone ?? profile.hidePhone),
    phone: profile.phone ?? profile.phone_number ?? profile.contact ?? null,
    verified_badge: Boolean(profile.verified ?? profile.is_verified),
  };
  // Validate that we got something meaningful
  if (!seller.username || seller.username === "Unknown") return null;
  return seller;
}

// ---------------------------------------------------------------------------
// Client class
// ---------------------------------------------------------------------------

export class JijiClient {
  constructor(private opts: { sampleMode?: boolean } = {}) {}

  async getItem(id: string): Promise<JijiListing | null> {
    if (!this.opts.sampleMode) {
      const raw = await tryLiveApi<any>(`/item/${id}/data.json`);
      if (raw) {
        const normalized = normalizeItem(raw, id);
        if (normalized) return normalized;
      }
    }
    return sampleListing(id);
  }

  async getSeller(id: string): Promise<JijiSeller | null> {
    if (!this.opts.sampleMode) {
      const raw = await tryLiveApi<any>(`/seller/${id}/data.json`);
      if (raw) {
        const normalized = normalizeSeller(raw, id);
        if (normalized) return normalized;
      }
    }
    return sampleSeller(id);
  }

  async search(query: string, page = 1): Promise<JijiSearchResult> {
    if (!this.opts.sampleMode) {
      const raw = await tryLiveApi<any>(
        `/search?q=${encodeURIComponent(query)}&page=${page}`
      );
      if (raw) {
        const normalized = normalizeSearch(raw, page);
        if (normalized) return normalized;
      }
    }
    return sampleSearch(query, page);
  }

  async getCategoryItems(slug: string, page = 1): Promise<JijiSearchResult> {
    if (!this.opts.sampleMode) {
      const raw = await tryLiveApi<any>(
        `/category/${slug}/items?page=${page}`
      );
      if (raw) {
        const normalized = normalizeSearch(raw, page);
        if (normalized) return normalized;
      }
    }
    return sampleSearch(slug, page);
  }
}

// ---------------------------------------------------------------------------
// Sample data generators (synthetic Jiji-style fallback)
// ---------------------------------------------------------------------------

const SAMPLE_QUERIES: Record<string, JijiListing[]> = {};
const SELLER_POOL: Record<string, JijiSeller> = {};

const KENYAN_NAMES = [
  "JohnKamau254", "WanjiruTech", "NairobiDeals", "MombasaHub", "KisumuGadgets",
  "NakuruTech", "EldoretMobile", "ThikaTech", "BrianM254", "AishaWanjiru",
  "TechHubKE", "CityDeals254", "FastFones", "GadgetZone", "MobileHubKE",
  "CyrilOtieno", "FaithNjeri", "PeterMwangi", "MercyAuma", "DanielKip",
];

const LOCATIONS = ["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Thika", "Kiambu", "Machakos"];

const PRODUCT_TEMPLATES = [
  { title: "iPhone 14 Pro Max 256GB", category: "phones-tablets", basePrice: 135000, cond: "new" },
  { title: "iPhone 14 128GB", category: "phones-tablets", basePrice: 85000, cond: "new" },
  { title: "iPhone 13 128GB", category: "phones-tablets", basePrice: 68000, cond: "used" },
  { title: "iPhone 12 64GB", category: "phones-tablets", basePrice: 52000, cond: "used" },
  { title: "Samsung Galaxy S23 Ultra", category: "phones-tablets", basePrice: 125000, cond: "new" },
  { title: "Samsung Galaxy A54", category: "phones-tablets", basePrice: 42000, cond: "new" },
  { title: "PlayStation 5 Slim", category: "electronics", basePrice: 78000, cond: "new" },
  { title: "PlayStation 5 Disc Edition", category: "electronics", basePrice: 72000, cond: "used" },
  { title: "Xbox Series X", category: "electronics", basePrice: 68000, cond: "new" },
  { title: 'Samsung 55" 4K Smart TV', category: "electronics", basePrice: 65000, cond: "new" },
  { title: "MacBook Pro M2 13-inch", category: "computers-laptops", basePrice: 185000, cond: "used" },
  { title: "HP Pavilion 15 i5", category: "computers-laptops", basePrice: 72000, cond: "new" },
  { title: "Dell XPS 13", category: "computers-laptops", basePrice: 110000, cond: "used" },
  { title: "AirPods Pro 2nd Gen", category: "electronics", basePrice: 28000, cond: "new" },
  { title: "Sony WH-1000XM5", category: "electronics", basePrice: 38000, cond: "new" },
  { title: "iPad Air 5th Gen", category: "electronics", basePrice: 88000, cond: "new" },
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function genSeller(id: string): JijiSeller {
  if (SELLER_POOL[id]) return SELLER_POOL[id];
  const username = pick(KENYAN_NAMES);
  const accountAgeDays = rand(2, 1800);
  const totalItems = accountAgeDays < 30 ? rand(1, 4) : rand(8, 280);
  // On classifieds sites, most sellers publish their phone for buyers to call.
  // A small fraction toggle "hide phone" — for those, we still test the
  // phone-leak signal (whether the API exposes it anyway).
  const hidePhone = Math.random() < 0.25;
  const phoneLeaked = hidePhone && Math.random() < 0.5;
  const phone =
    !hidePhone || phoneLeaked ? `+2547${rand(10, 99)}${rand(100000, 999999)}` : null;
  const seller: JijiSeller = {
    id,
    username,
    location: pick(LOCATIONS),
    account_age_days: accountAgeDays,
    total_items: totalItems,
    rating: accountAgeDays < 30 ? Math.random() * 3 : 3.5 + Math.random() * 1.5,
    hide_phone: hidePhone,
    phone,
    verified_badge: accountAgeDays > 180 && totalItems > 30,
  };
  SELLER_POOL[id] = seller;
  return seller;
}

function genPriceHistory(basePrice: number, daysOnMarket: number, fakeDiscount: boolean) {
  const history: { price: number; recorded_at: string }[] = [];
  const now = Date.now();
  const points = Math.min(daysOnMarket + 1, 12);
  if (fakeDiscount && daysOnMarket >= 6) {
    const peak = Math.round(basePrice * 1.25);
    const current = Math.round(basePrice * 0.92);
    const peakIdx = Math.floor(points * 0.6);
    for (let i = 0; i < points; i++) {
      let price: number;
      if (i < peakIdx) {
        price = basePrice + Math.round((peak - basePrice) * (i / peakIdx));
      } else if (i === peakIdx) {
        price = peak;
      } else {
        price = peak - Math.round((peak - current) * ((i - peakIdx) / (points - peakIdx - 1)));
      }
      history.push({
        price,
        recorded_at: new Date(now - (points - i) * 24 * 3600 * 1000).toISOString(),
      });
    }
  } else {
    const smallDrop = Math.random() < 0.3;
    for (let i = 0; i < points; i++) {
      let price = basePrice;
      if (smallDrop && i > points * 0.6) {
        price = Math.round(basePrice * 0.92);
      }
      history.push({
        price,
        recorded_at: new Date(now - (points - i) * 24 * 3600 * 1000).toISOString(),
      });
    }
  }
  return history;
}

function sampleListing(idHint?: string): JijiListing {
  const id = idHint ?? `listing-${rand(100000, 999999)}`;
  const tpl = pick(PRODUCT_TEMPLATES);
  const seller = genSeller(`seller-${rand(1, 12)}`);
  const daysOnMarket = rand(1, 60);
  const fakeDiscount = Math.random() < 0.18;
  const currentPrice = fakeDiscount
    ? Math.round(tpl.basePrice * 0.92)
    : Math.round(tpl.basePrice * (0.85 + Math.random() * 0.25));
  const imageCount = rand(1, 8);
  return {
    id,
    title: tpl.title,
    price: currentPrice,
    currency: "KES",
    category: tpl.category,
    condition: tpl.cond,
    location: seller.location,
    url: `${JIJI_BASE}/${tpl.category}/${slugify(tpl.title)}/${id}`,
    images: Array.from({ length: imageCount }, (_, i) => ({
      url: `https://cdn.jiji.co.ke/img/${id}-${i}.jpg`,
      width: 800,
      height: 600,
    })),
    views: rand(20, 4500),
    days_on_market: daysOnMarket,
    seller,
    price_history: genPriceHistory(tpl.basePrice, daysOnMarket, fakeDiscount),
  };
}

function sampleSearch(query: string, page: number): JijiSearchResult {
  const key = `${query}-${page}`;
  if (SAMPLE_QUERIES[key]) return { items: SAMPLE_QUERIES[key], total: 48, page };

  const q = query.toLowerCase();
  const matching = PRODUCT_TEMPLATES.filter(
    (t) => t.title.toLowerCase().includes(q) || t.category.includes(q)
  );
  const pool = matching.length > 0 ? matching : PRODUCT_TEMPLATES;

  const count = rand(8, 14);
  const items: JijiListing[] = Array.from({ length: count }, () => sampleListing());
  items.forEach((it, i) => {
    if (i < pool.length) {
      const tpl = pool[i];
      it.title = tpl.title;
      it.category = tpl.category;
      it.condition = tpl.cond;
    }
  });

  SAMPLE_QUERIES[key] = items;
  return { items, total: 48, page };
}

// Default singleton — live mode with sample fallback.
export const jiji = new JijiClient({ sampleMode: false });
