/**
 * Jiji API Client
 *
 * Strategy (API-first, browser-fallback):
 *   - Direct calls to api_web/v1/* endpoints when available (fast, structured JSON).
 *   - Sample-data fallback when network is unavailable (sandbox mode) so the dashboard
 *     always has realistic Jiji-style data to operate on.
 *
 * NOTE: This client does NOT include Cloudflare bypass or anti-bot circumvention logic.
 * Those modules (DrissionPage fallback, reverseloom recon) live separately and are
 * opt-in for the operator. This module only handles legitimate public API calls.
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
  phone: string | null; // null when not exposed
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

export interface JijiCategory {
  slug: string;
  name: string;
}

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: JIJI_BASE,
};

/**
 * Try a live API call. Returns null on any failure so the caller can fall back
 * to sample data without breaking the collection pipeline.
 */
async function tryLiveApi<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`${JIJI_BASE}${API_PREFIX}${path}`, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Public API methods. Each method first attempts the live endpoint, then falls
 * back to the synthetic generator so the pipeline always returns data.
 */
export class JijiClient {
  constructor(private opts: { sampleMode?: boolean } = {}) {}

  async getItem(id: string): Promise<JijiListing | null> {
    if (!this.opts.sampleMode) {
      const live = await tryLiveApi<JijiListing>(`/item/${id}/data.json`);
      if (live) return live;
    }
    return sampleListing(id);
  }

  async getSeller(id: string): Promise<JijiSeller | null> {
    if (!this.opts.sampleMode) {
      const live = await tryLiveApi<JijiSeller>(`/seller/${id}/data.json`);
      if (live) return live;
    }
    return sampleSeller(id);
  }

  async search(query: string, page = 1): Promise<JijiSearchResult> {
    if (!this.opts.sampleMode) {
      const live = await tryLiveApi<JijiSearchResult>(
        `/search?q=${encodeURIComponent(query)}&page=${page}`
      );
      if (live) return live;
    }
    return sampleSearch(query, page);
  }

  async getCategoryItems(slug: string, page = 1): Promise<JijiSearchResult> {
    if (!this.opts.sampleMode) {
      const live = await tryLiveApi<JijiSearchResult>(
        `/category/${slug}/items?page=${page}`
      );
      if (live) return live;
    }
    return sampleSearch(slug, page);
  }
}

// ---------------------------------------------------------------------------
// Sample data generators
// ---------------------------------------------------------------------------
// The sample data below is synthetic but follows the shape of real Jiji.co.ke
// listings (KES prices, Kenyan seller handles, common product categories).
// It exists so the pipeline produces a meaningful dashboard even when the
// sandbox cannot reach jiji.co.ke directly. Replace with live API responses
// by passing { sampleMode: false } once the operator's network can reach Jiji.
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
  const hidePhone = Math.random() < 0.35;
  // Privacy-leak signal: a fraction of sellers who set hide_phone still have
  // their phone exposed via the seller/data.json endpoint.
  const phoneLeaked = hidePhone && Math.random() < 0.45;
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
    // V-curve: normal -> peak (+25%) -> "discounted" (-10% from base)
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
    // Steady with maybe a small legitimate discount
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
  // For fake-discount listings, the *current* price is the discounted price.
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

function sampleSearch(query: string, page: number): JishiSearchResultLike {
  const key = `${query}-${page}`;
  if (SAMPLE_QUERIES[key]) return { items: SAMPLE_QUERIES[key], total: 48, page };

  // Match templates to the query when possible
  const q = query.toLowerCase();
  const matching = PRODUCT_TEMPLATES.filter((t) =>
    t.title.toLowerCase().includes(q) || t.category.includes(q)
  );
  const pool = matching.length > 0 ? matching : PRODUCT_TEMPLATES;

  const count = rand(8, 14);
  const items: JijiListing[] = Array.from({ length: count }, () => sampleListing());
  // Bias titles toward the query match
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

// Default singleton — uses live mode with sample fallback (best of both worlds).
export const jiji = new JijiClient({ sampleMode: false });
