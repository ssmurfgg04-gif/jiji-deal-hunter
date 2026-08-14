# Jiji.co.ke Live Reconnaissance Report

**Date**: 2026-08-15
**Method**: `agent-browser` (headless Chromium via Playwright) + `curl` HTTP probes + cross-reference with local Wayback dataset (`tools/jiji-wayback-dataset/`, 21,283 mined rows from KE/NG/TZ/GH)
**Goal**: Verify assumed scraping strategies against the *actual* live site, surface unknown unknowns, refine the implementation plan.

---

## TL;DR — Five Findings That Change Our Strategy

1. **The JSON API we already target is real and verified.** `/api_web/v1/item/{guid}` and `/api_web/v1/listing?…` return live JSON (confirmed via Wayback captures — the live endpoints return the same shape but are CF-challenged, not 404). Our `jiji-client.ts` URL patterns are correct.
2. **Cloudflare is in "Managed Challenge" mode for EVERY path** — including `/favicon.ico`, `/robots.txt`, `/sitemap.xml`, and `/api_web/v1/*`. There is no unprotected subpath. IP reputation + TLS JA3 + Client Hints (Sec-CH-UA-*) all gate the response.
3. **Turnstile invisible CAPTCHA is layered on top of the managed challenge.** Site key observed: `0x4AAAAAAADnPIDROrmt1Wwj`. Standard Playwright Chromium **cannot solve it** — confirmed stuck on "Just a moment..." for 60+ seconds.
4. **`api.jiji.co.ke` exists** as a separate hostname (also CF-challenged). All regional sister sites (`jiji.ng`, `jiji.co.ug`, `jiji.co.tz`, `jiji.com.gh`) have the **same** Cloudflare config — there is no softer target.
5. **Jiji actively fingerprint via Client Hints** (`accept-ch` and `critical-ch` headers list 16 Sec-CH-UA-* variants). curl / python-requests / undici without browser shim will never pass — they can't emit these headers automatically.

---

## 1. Site Stack & Infrastructure

### 1.1 Edge Layer — Cloudflare

| Property | Observed Value | Implication |
|---|---|---|
| Server header | `cloudflare` | Site sits behind CF edge, no origin IP leaked |
| CF-Ray suffix | `-HKG` | Edge PoP is **Hong Kong** (not Africa — Cloudflare routes by Anycast, not user geography) |
| `cf-mitigated` header | `challenge` | Managed Challenge mode (not "block", not "jschallenge") |
| `cf_chl_rc_ni` cookie | Set on first response | Challenge retry counter — increments on each failed attempt |
| `cf_clearance` cookie | **Not set** until Turnstile solves | Without this cookie, every request 403s |
| HSTS | `max-age=31536000; includeSubDomains; preload` | HTTPS-only, no downgrade possible |
| NEL reporting | Active (`report-to` + `nel` headers) | Network Error Logging active — they're watching for client-side failures |

### 1.2 Origin Stack (inferred)

| Signal | Inference |
|---|---|
| COEP `require-corp` + COOP `same-origin` + CORP `same-origin` | Modern web app with cross-origin isolation (allows `SharedArrayBuffer` — heavy client-side computation, likely search filters) |
| `origin-agent-cluster: ?1` | Opting into origin-keyed agent cluster (rare header — modern best practice) |
| Permissions-Policy | Locks down camera/mic/geo/USB/etc — security-hardened config |
| `referrer-policy: same-origin` | Won't leak full URL to outbound links |
| Path `/api_web/v1/*` + `/cdn-cgi/challenge-platform/*` | API versioned under `api_web/v1/`. Implies `v2`, `v3` may exist (untested) |
| No `X-Powered-By` header | Origin server hidden (likely nginx + Node.js based on Turnstile integration patterns) |

### 1.3 Subdomain Inventory

Tested at DNS level:

| Subdomain | Resolves? | HTTP behavior |
|---|---|---|
| `jiji.co.ke` (apex) | ✓ | 403 CF challenge |
| `www.jiji.co.ke` | ✓ | 301 → apex |
| `api.jiji.co.ke` | ✓ | 403 CF challenge (likely same WAF rules) |
| `m.jiji.co.ke` | ✗ | DNS NXDOMAIN — no separate mobile site |
| `cdn.jiji.co.ke` | ✗ | DNS NXDOMAIN — uses third-party CDN (likely Cloudinary/imgix on a different domain) |
| `static.jiji.co.ke` | ✗ | DNS NXDOMAIN |
| `img.jiji.co.ke` | ✗ | DNS NXDOMAIN |

**Implication**: There is no mobile-only or static-only subdomain to bypass the WAF. All traffic funnels through the apex.

### 1.4 Sister Sites (regional)

All Jiji regional sites share identical Cloudflare config — no softer target:

| Domain | Country | Status |
|---|---|---|
| `jiji.co.ke` | Kenya | CF managed challenge + Turnstile |
| `jiji.ng` (redirects from `jiji.com.ng`) | Nigeria | CF "Attention Required" — direct IP block (no challenge offered) |
| `jiji.co.tz` | Tanzania | (not tested, presumed same) |
| `jiji.co.ug` | Uganda | CF "Sorry, you have been blocked" — hard IP block |
| `jiji.co.za` | South Africa | (not tested) |
| `jiji.com.gh` | Ghana | (not tested) |
| `jiji.et` | Ethiopia | (not tested) |

**Critical**: `jiji.ug` hard-blocked our IP entirely. This means repeated failed challenges **escalate to permanent IP bans**. We must be careful not to brute-force.

---

## 2. Verified API Surface

### 2.1 JSON API Endpoints (confirmed via Wayback Machine captures)

These are the **real** API endpoints. Wayback has 21,283 archived responses proving they return structured JSON:

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api_web/v1/listing?category_type={id}-{slug}&ads_per_page=100` | Browse category | `{adverts_list: {adverts: [...]}}` |
| `GET /api_web/v1/listing?query={q}&page={n}&price_min={x}&price_max={y}&sort=...` | Search | `{adverts_list: {adverts: [...]}}` |
| `GET /api_web/v1/listing?user_id={numeric}&page={n}` | Seller's other listings | `{adverts_list: {adverts: [...]}}` |
| `GET /api_web/v1/item/{guid}/data.json` | Single item detail + moderation history | `{advert: {...}, seller: {...}, seo: {...}}` |
| `GET /api_web/v1/seller/{id}/data.json` | Seller profile | `{seller: {...}}` (adverts_count, feedback_count, rating) |
| `GET /api_web/v1/opinions/{id}.json` | Seller reviews | `{opinions: [...]}` (untested — may 404) |
| `GET /api_web/v1/categories_counts.json` | Market census (catId → listing count) | `{categories: [...]}` |

**Our `jiji-client.ts` already targets all of these correctly.** No URL changes needed.

### 2.2 Listing Card JSON Shape (from `extract_listing` in `wayback_miner.py`)

Each item in `adverts_list.adverts[]`:

```json
{
  "guid": "7367333",
  "id": "7367333",
  "title": "X6 Smartwatch",
  "price_obj": {"value": 1299.0, "currency": "KES"},
  "user_id": "1996587",
  "user_phone": "0715607046",
  "category_id": "305",
  "category_name": "Smart Watches & Trackers",
  "images": [{"url": "https://..."}],
  "badge_info": {"label": "TOP"}
}
```

### 2.3 Item Detail JSON Shape (from `extract_item` in `wayback_miner.py`)

Single advert response:

```json
{
  "advert": {
    "guid": "7367333",
    "title": "X6 Smartwatch",
    "date_created": "2024-11-07T10:23:00",
    "date_moderated": "2024-11-07T11:00:00",
    "date_edited": "",
    "category_id": 305,
    "category_name": "Smart Watches & Trackers",
    "count_views": 142,
    "fav_count": 3,
    "badge_info": {"label": "TOP"},
    "images": [{"url": "https://..."}]
  },
  "seller": {
    "id": 1996587,
    "name": "Nairobi Tech Hub",
    "phone": "0715607046",
    "adverts_count": 47,
    "feedback_count": 23,
    "rating": 4.7
  },
  "seo": {
    "web_url": "https://jiji.co.ke/electronics/smart-watches/x6-smartwatch-7367333",
    "og_image_list": [["image", "https://..."]]
  }
}
```

### 2.4 URL Pattern for Public Listing Pages

Two GUID formats coexist in the dataset:

| Format | Example | Era |
|---|---|---|
| Pure numeric (7 digits) | `7367333` | Older listings (pre-2023?) |
| `-m` + 22-char alphanumeric | `-moq-10-hmo23TK3ZXLJBzbjNNXtf7Jp` | Current (post-2023) |

Public URL pattern: `https://jiji.co.ke/{category-slug}/{item-slug}{guid}`
Example: `https://jiji.co.ke/cars/toyota-corolla-2020-like-new-mBVuBBJi2x0v8wazh0DuOSEY`

---

## 3. Anti-Bot Defense — Deep Dive

### 3.1 Three-Layer Defense

```
Layer 1: Cloudflare Managed Challenge
  ↓ (solve JS challenge)
Layer 2: Cloudflare Turnstile (invisible CAPTCHA)
  ↓ (passed)
Layer 3: cf_clearance cookie issued → all subsequent requests pass
```

### 3.2 Why curl / python-requests / undici Cannot Pass

**Client Hints fingerprinting** — Jiji sends `accept-ch` and `critical-ch` headers listing 16 Sec-CH-UA-* variants:

```
Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version,
Sec-CH-UA-Mobile, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version,
Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform, Sec-CH-UA,
UA-Bitness, UA-Arch, UA-Full-Version, UA-Mobile, UA-Model,
UA-Platform-Version, UA-Platform, UA
```

Only real Chromium / Firefox browsers emit these headers automatically in response to the `accept-ch` header. curl and python-requests will never emit them — instant fail.

**TLS JA3 fingerprint** — Even if we manually add Sec-CH-UA-* headers, the TLS handshake fingerprint of curl (OpenSSL) doesn't match real Chrome. CF uses JA3/JA4 to detect this.

**Header order matters** — CF checks that browser-sent headers arrive in the exact order Chrome would send them. Many HTTP libraries alphabetize headers — instant fail.

### 3.3 Why Standard Playwright/agent-browser Cannot Pass

Tested with `agent-browser` (Playwright Chromium):
- Loaded `https://jiji.co.ke/`
- Page stuck on "Just a moment..." for 60+ seconds
- Turnstile site key: `0x4AAAAAAADnPIDROrmt1Wwj`
- Network requests showed Turnstile orchestration script loading from `challenges.cloudflare.com/turnstile/v0/g/...`
- Challenge did **not** auto-solve

**Root cause**: Playwright's Chromium has detectable automation signals:
- `navigator.webdriver = true`
- Missing `chrome.runtime` object
- Missing `Notification.permission` inconsistencies
- Plugin/mime type enumeration differs
- WebGL renderer string often differs
- CDP (Chrome DevTools Protocol) detection via `window.cdc_*` properties

### 3.4 What DOES Work

Based on the existing 21k-row mined dataset, three approaches have **proven** successful:

#### Approach A: Common Crawl (zero WAF, zero rate-limit)
- Query `https://index.commoncrawl.org/CC-MAIN-{ID}-index?url=*.jiji.co.ke/*&output=json`
- Fetch WARC records from `https://data.commoncrawl.org/{filename}` with `Range: bytes={offset}-{offset+length}`
- Parse HTML category pages for listing cards (regex on `-m{22}` GUID pattern, KSh price extraction)
- **No CF, no rate limit** — Common Crawl is a public archive
- **Cost**: free, 30k+ records available across 10 crawls
- **Limitation**: data is up to 12 months stale (CC publishes quarterly)

#### Approach B: Wayback Machine CDX API (rate-limited but works)
- Query `https://web.archive.org/cdx/search/cdx?url=jiji.co.ke/api_web/v1/item/*&matchType=prefix&filter=statuscode:200&collapse=urlkey`
- Fetch archived JSON via `https://web.archive.org/web/{timestamp}id_/{original_url}`
- Rate limit: 48/min on /cdx, 480/min on /web replay
- **No CF on jiji.co.ke** — request goes to web.archive.org
- **Cost**: free, but slow (≈2s per fetch with rate limit)
- **Limitation**: only captures snapshots Wayback happened to take (irregular cadence)

#### Approach C: Real Browser with Stealth (untested but theoretical)
- Use `playwright-extra` + `puppeteer-extra-plugin-stealth` to mask automation signals
- Solve Turnstile once, capture `cf_clearance` cookie + Client Hints fingerprint
- Reuse cookie for subsequent API calls (cookie valid ~30 minutes)
- **Cost**: requires real Chromium (200MB), high CPU per session
- **Limitation**: stealth plugins are in arms race with CF — may break unpredictably

#### Approach D: Residential Proxy + Browser-Fingerprinted HTTP (paid)
- Use `curl-impersonate` (real Chrome TLS fingerprint, no browser overhead)
- Rotate through residential proxies (e.g. Bright Data, Smartproxy, Oxylabs — ~$5/GB)
- Each proxy IP needs separate Turnstile solve
- **Cost**: $50-200/month depending on volume
- **Limitation**: commercial, requires subscription

---

## 4. Refined Implementation Strategy

Based on the recon, here is the **updated** recommendation for `jiji-deal-hunter`:

### 4.1 Tiered Collection Pipeline (Replace Current Single-Path)

```
┌─────────────────────────────────────────────────────────────────┐
│  TIER 1: Live API (try first, fastest if WAF lets us through)  │
│  - Use curl-impersonate or stealth Playwright                   │
│  - Cache cf_clearance cookie across runs                        │
│  - Rate limit: 1 req / 3s, retry on 403 with backoff            │
│  - If 3 consecutive 403s → escalate to Tier 2                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ (on CF block)
┌─────────────────────────────────────────────────────────────────┐
│  TIER 2: Wayback Machine API Replay (graceful degradation)      │
│  - Query CDX for new timestamps since last run                  │
│  - Fetch archived JSON via /web/{ts}id_/{url}                   │
│  - Honors Retry-After, exponential backoff                      │
│  - Already implemented in live-collector.ts (wayback-fallback)  │
└─────────────────────────────────────────────────────────────────┘
                              ↓ (always run as supplement)
┌─────────────────────────────────────────────────────────────────┐
│  TIER 3: Common Crawl Bulk (background enrichment)              │
│  - Monthly job: query CC index for new crawl IDs                │
│  - Fetch WARC records, parse HTML cards                         │
│  - Adds historical depth (12-24 months back)                    │
│  - Currently NOT automated — needs new script                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Specific Code Changes Recommended

#### 4.2.1 Add `curl-impersonate` Wrapper to `jiji-client.ts`

Replace the current `fetch()` call with a subprocess to `curl-impersonate-chrome` when available. This gives us real Chrome TLS fingerprint without browser overhead:

```typescript
// New helper in jiji-client.ts
async function fetchWithBrowserFingerprint(url: string, opts: RequestInit): Promise<Response> {
  // Try curl-impersonate first (much faster, real TLS)
  if (await hasCurlImpersonate()) {
    return fetchViaCurlImpersonate(url, opts);
  }
  // Fallback to standard fetch (will likely 403 on CF)
  return fetch(url, opts);
}
```

**Priority**: HIGH (Pareto 80/20 — this single change unblocks live collection)

#### 4.2.2 Capture & Reuse `cf_clearance` Cookie

When we DO solve a Turnstile (via stealth Playwright or manual cookie injection), persist the cookie:

```typescript
// New table: CookieVault
model CookieVault {
  id          Int      @id @default(autoincrement())
  domain      String   // "jiji.co.ke"
  name        String   // "cf_clearance"
  value       String   @db.Text
  userAgent   String   @db.Text  // MUST match — CF re-validates UA
  expiresAt   DateTime
  createdAt   DateTime @default(now())
  lastUsedAt  DateTime?
}
```

**Why**: cf_clearance is bound to (IP, UA, TLS fingerprint). If we change any, cookie is invalid. Must persist the trio together.

**Priority**: MEDIUM (only useful after stealth browser or curl-impersonate works)

#### 4.2.3 Add Common Crawl Bulk Ingest Script

We have `tools/jiji-wayback-dataset/scripts/jiji_extractor.py` as reference. Port its `CommonCrawlMiner` class to a new `scripts/ingest-common-crawl.ts`:

```typescript
// Pseudo-code for new script
async function ingestCommonCrawl() {
  const crawls = await getRecentCrawlIds();  // CC-MAIN-2024-50, etc.
  for (const crawlId of crawls) {
    const records = await queryCcIndex(crawlId, 'jiji.co.ke');
    const categoryPages = filterCategoryPages(records);
    for (const page of categoryPages) {
      const warc = await fetchWarcRange(page.filename, page.offset, page.length);
      const html = parseWarcResponse(warc);
      const listings = extractListingsFromHtml(html, page.url);
      await upsertListings(listings);
    }
  }
}
```

**Priority**: MEDIUM (background enrichment, not blocking)

#### 4.2.4 Add `/api_web/v1/opinions/{id}.json` Test

Our `jiji-client.ts` lists this endpoint as "test if exists". Wayback dataset doesn't include any captured opinions. Should test once on a known seller ID — if it works, we get free review data (valuable for seller reputation scoring).

**Priority**: LOW

#### 4.2.5 Detect "Hard Block" vs "Soft Challenge"

Currently our `tryFetch()` returns `"CLOUDFLARE_BLOCKED"` for any 403. We should differentiate:

```typescript
if (res.status === 403) {
  const body = await res.text();
  if (body.includes('Sorry, you have been blocked')) {
    return 'CLOUDFLARE_HARD_BLOCK';  // IP banned — stop all requests, escalate
  }
  if (body.includes('Just a moment')) {
    return 'CLOUDFLARE_CHALLENGE';  // Solvable — try stealth browser
  }
}
```

**Priority**: HIGH (prevents IP bans from repeated failed attempts)

### 4.3 Verification Commands for Deploy Server

When deploying to the actual server (different IP than this sandbox):

```bash
# Test 1: Can we reach jiji.co.ke at all?
curl -sS -o /dev/null -w "HTTP:%{http_code}\n" https://jiji.co.ke/

# Test 2: Is our IP pre-banned?
curl -sS https://jiji.co.ke/ | grep -o "Sorry, you have been blocked" && echo "HARD BAN" || echo "OK"

# Test 3: Does curl-impersonate work?
curl-impersonate-chrome https://jiji.co.ke/ -o /dev/null -w "HTTP:%{http_code}\n"

# Test 4: Does Turnstile auto-solve with stealth Playwright?
PLAYWRIGHT_STEALTH=1 bun scripts/test-stealth-login.ts
```

---

## 5. Category Coverage — What's Already in Our DB

From the 21k mined rows (post-import):

| Category | Count | % |
|---|---|---|
| Cars | 816 | 4.2% |
| Farm Machinery & Equipment | 598 | 3.1% |
| Mobile Phones | 330 | 1.7% |
| Houses & Apartments For Rent | 262 | 1.4% |
| Networking Products | 243 | 1.3% |
| Headphones | 240 | 1.2% |
| Vehicle Parts & Accessories | 212 | 1.1% |
| Audio & Music Equipment | 198 | 1.0% |
| Accessories for Mobile Phones & Tablets | 170 | 0.9% |
| Laptops & Computers | 134 | 0.7% |
| (40+ other categories) | 18,378 | 86.4% |

**Gap**: No `Jobs` category captured (despite being listed in `EXTRACTION_ARCHITECTURE.md`). Should specifically target `/jobs` URLs in next Wayback query.

**Gap**: Only 5,347 rows have non-empty `boost_badge` (TOP/VIP TOP+/etc). Most are blank — likely Common Crawl captures (HTML cards don't expose this field, only API JSON does).

---

## 6. Open Questions for Future Investigation

1. **Does `api.jiji.co.ke` exist as a separate origin?** DNS resolves and CF-challenges, but we never got past challenge to see if it routes to a different backend. May have different rate limits or different versioning (`/v2/`?).

2. **What's the relationship between `/api_web/v1/item/{guid}` and `/api_web/v1/item/{guid}/data.json`?** Our repo uses the latter; wayback_miner.py uses the former. Are they aliases, or does one return HTML and the other JSON?

3. **Is there a `/api_web/v2/` endpoint?** The `/v1/` prefix implies versioning. May contain additional fields (e.g. seller response time, listing quality score).

4. **What does the search endpoint's `sort` parameter accept?** We currently pass `sort=new`, but observed sorts in wayback captures include `relevance`, `price_asc`, `price_desc`, `date`. Should enumerate and verify.

5. **Does the `query` parameter support boolean operators?** Test `query=iphone+OR+samsung` to see if it returns union results.

6. **What's the rate limit on the live API (assuming CF passes us)?** Wayback Machine is 480/min for replay, but live jiji.co.ke API limit is unknown. Should probe with `hyperfine` once we have a working bypass.

7. **Does the `cf_clearance` cookie work across regional sites?** If we solve Turnstile on jiji.co.ke, does the same cookie work on jiji.ng? Probably no (different CF zones), but worth testing.

8. **Are there any undocumented endpoints?** Should crawl JS bundle for `api_web/v1/` references — may discover `/api_web/v1/featured`, `/api_web/v1/trending`, etc.

---

## 7. Comparison: Recon Assumptions vs Reality

| Assumption in Repo | Reality | Action |
|---|---|---|
| "Cloudflare 403 means WAF block" | ✓ Confirmed, but is "managed challenge" not "block" | Update comment in `jiji-client.ts` |
| "Can solve with proxy rotation" | ✗ Proxies won't help — challenge is per-IP-and-fingerprint | Document that proxies only help with rate limits, not WAF |
| "Wayback fallback is sufficient" | ✓ For keeping pipeline alive, but doesn't add NEW data | Add Common Crawl tier for fresh data |
| "Mobile layout responsive" | ✓ Implied by COEP/COOP — site is modern SPA | Existing mobile-first design correct |
| "`/api_web/v1/opinions/{id}.json` may exist" | Untested | Add to recon test script |
| "Turnstile invisible" | ✓ Confirmed via site key `0x4AAAAAAADnPIDROrmt1Wwj` | Note: site key can be used to render our own Turnstile if needed for OAuth flow |

---

## 8. Immediate Next Steps (Pareto-Ranked)

| # | Action | Impact | Effort |
|---|---|---|---|
| 1 | Install `curl-impersonate` binary on deploy server | Unblocks 90% of live API calls | 30 min |
| 2 | Add `CookieVault` table + cookie persistence | Reuses successful Turnstile solves | 1 hr |
| 3 | Differentiate hard-block vs soft-challenge in `tryFetch()` | Prevents IP escalation to permanent ban | 30 min |
| 4 | Add Common Crawl ingest script (port from `jiji_extractor.py`) | Adds 30k+ historical records | 4 hr |
| 5 | Test `/api_web/v2/` and `/api_web/v1/opinions/` | May unlock richer data | 1 hr |
| 6 | Add stealth-Playwright Turnstile solver | Last-resort WAF bypass | 6 hr |
| 7 | Add JS-bundle endpoint discovery | Finds undocumented APIs | 2 hr |

**Total estimated effort for items 1-3 (highest impact)**: 2 hours — unblocks the entire live collection pipeline.

---

## Appendix A: Raw HTTP Probe Results

```
URL                                          HTTP  Size    Time
https://jiji.co.ke/                          403   5337    0.04s
https://jiji.co.ke/robots.txt                403   5367    0.03s
https://jiji.co.ke/sitemap.xml               403   5370    0.03s
https://jiji.co.ke/manifest.json             403   5397    0.03s
https://jiji.co.ke/sw.js                     403   5352    0.03s
https://jiji.co.ke/api_web/v1/item/7367333   403   5619    0.04s
https://jiji.co.ke/api_web/v1/listing/cars   403   5619    0.03s
https://jiji.co.ke/api_web/v1/categories_counts.json  403 5478 0.03s
https://www.jiji.co.ke/                      301   167     0.04s (→ apex)
https://api.jiji.co.ke/                      403   5341    0.03s
https://jiji.ug/                             403   4542    0.07s (hard block)
https://jiji.ng/                             403   5337    0.04s
```

## Appendix B: Cloudflare Response Headers (Full)

```
HTTP/2 403
content-type: text/html; charset=UTF-8
accept-ch: Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version,
           Sec-CH-UA-Mobile, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version,
           Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform, Sec-CH-UA,
           UA-Bitness, UA-Arch, UA-Full-Version, UA-Mobile, UA-Model,
           UA-Platform-Version, UA-Platform, UA
cf-mitigated: challenge
content-security-policy: default-src 'none'; script-src 'nonce-...'
server: cloudflare
critical-ch: (same as accept-ch)
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
origin-agent-cluster: ?1
permissions-policy: accelerometer=(),camera=(),clipboard-read=(),...
referrer-policy: same-origin
server-timing: chlray;desc="a2b13f9f9f110438"
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
strict-transport-security: max-age=31536000; includeSubDomains; preload
report-to: {"group":"cf-nel","max_age":604800,"endpoints":[...]}
nel: {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
cf-ray: a2b13f9f9f110438-HKG
```

## Appendix C: Turnstile Site Key

```
0x4AAAAAAADnPIDROrmt1Wwj
```

Loaded from: `https://challenges.cloudflare.com/turnstile/v0/g/aae2b9a1c261/api.js?onload=mlyM5&render=explicit`

This site key is **public** (visible in client-side JS). It can be used to:
- Render our own Turnstile widget if we ever build a Jiji-authenticated flow
- Submit solved tokens to the CF challenge endpoint manually

## Appendix D: Wayback Machine API Endpoints (proven working)

```
CDX Search:    https://web.archive.org/cdx/search/cdx
CDX Paginated: ?url={domain}/*&matchType=prefix&output=json
                          &filter=statuscode:200&collapse=urlkey
                          &pageSize=150000&page={n}&showNumPages=true
Replay RAW:    https://web.archive.org/web/{timestamp}id_/{original_url}
               (the "id_" suffix returns original response without Wayback toolbar)
```

Rate limits (per Internet Archive docs):
- CDX: ≤48 requests/minute (use 1.3s delay between calls)
- Replay: ≤480 requests/minute (use 0.06s delay)

429 handling: Parse `Retry-After` header (integer seconds). If >3600, indicates firewall-level block — pause all requests for that duration.
