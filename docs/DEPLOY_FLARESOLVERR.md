# Deploy FlareSolverr — Tier 1 Cloudflare Bypass

> **Goal**: Stand up a self-hosted FlareSolverr instance that solves Cloudflare
> Managed Challenge + Turnstile on demand, returning `cf_clearance` cookies
> that work with our existing `curl-impersonate` setup.
>
> **Cost**: FREE (self-hosted). ~512MB RAM on the deploy server.
>
> **Time to deploy**: 10 minutes.

---

## What FlareSolverr Does

FlareSolverr is a proxy server that runs an undetected Chrome instance. When
you POST it a URL, it:

1. Opens the URL in headless Chrome
2. Solves any Cloudflare challenge (Managed Challenge, Turnstile, JS challenge)
3. Returns:
   - The cleared response body (HTML or JSON)
   - The `cf_clearance` and `__cf_bm` cookies (valid ~30 min)
   - The User-Agent that solved the challenge (must be reused for cookie validity)

Our `cf-bypass.ts` orchestrator saves those cookies to the `CookieVault` Prisma
table. Subsequent API calls via `tryFetch()` automatically pick up the saved
cookies and bypass CF entirely — no need to re-solve for ~30 minutes.

One solve → thousands of API calls. Decoupled cookie acquisition from API throughput.

---

## Deploy Steps

### 1. Install Docker (if not already)

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out + back in for group change to take effect

# Verify
docker --version
docker compose version
```

### 2. Start FlareSolverr

```bash
cd /path/to/jiji-deal-hunter
docker compose -f docker-compose.flaresolverr.yml up -d
```

### 3. Verify it's up

```bash
curl http://localhost:8191/
# Expected: HTML page with "FlareSolverr" title
```

### 4. Test it against jiji.co.ke

```bash
curl -X POST http://localhost:8191/v1 \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "request.get",
    "url": "https://jiji.co.ke/api_web/v1/categories_counts.json",
    "maxTimeout": 60000
  }' | jq .
```

Expected response:
```json
{
  "status": "ok",
  "message": "Challenge solved!",
  "solution": {
    "url": "https://jiji.co.ke/api_web/v1/categories_counts.json",
    "status": 200,
    "headers": {...},
    "response": "{\"categories\":[...]}",
    "cookies": [
      {"name": "cf_clearance", "value": "...", ...},
      {"name": "__cf_bm", "value": "...", ...}
    ],
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

### 5. Configure environment

Add to your `.env`:

```bash
# Tier 1 — FlareSolverr (already default, just confirming)
FLARESOLVERR_URL=http://localhost:8191/v1
FLARESOLVERR_TIMEOUT_MS=60000
```

### 6. Restart the app

```bash
npm run build && npm run start
# or
npm run dev
```

### 7. Trigger a live collection run

Hit any endpoint that triggers `tryLiveApi()`. The logs should show:

```
[jiji-client] Cloudflare SOFT_CHALLENGE on /api_web/v1/categories_counts.json — invoking CF bypass chain...
[cf-bypass] Tier 1 (FlareSolverr) attempting https://jiji.co.ke/api_web/v1/categories_counts.json
[flaresolverr] Solved https://jiji.co.ke/api_web/v1/categories_counts.json — 2 cookies saved, UA=Mozilla/5.0 ... Chrome/120.0..., body=4523b
[jiji-client] CF bypass succeeded via flaresolverr (18342ms, cookiesSaved=2)
[jiji-client] Live API success — saved 87 categories
```

For the next ~30 minutes, all API calls will use the saved cookie — no FlareSolverr calls needed.

---

## Optional: Sign up for Tier 2 + Tier 3 (paid fallbacks)

> **⚠️ Manual signup required.** Both Spider.cloud and Apify protect their
> signup pages with CAPTCHAs (Turnstile / reCAPTCHA v2). Automated signup
> via agent-browser + temp email was attempted and blocked. You'll need to
> sign up manually via a real browser.

### Tier 2 — Spider.cloud (freemium, $1/GB)
1. Go to https://spider.cloud in a real browser
2. Click "Register" — solve the Turnstile challenge manually
3. Verify email, log in
4. Get your API key from the dashboard
5. Add to `.env`:
   ```
   SPIDER_API_KEY=spider-xxxxxxxxxxxx
   ```

**Note**: Spider.cloud's no-key tier does NOT bypass CF (verified — returns
403 + "Cloudflare detected — set 'request' to 'chrome'"). You need a paid
API key for the `request: chrome` mode to actually invoke their browser
rendering + residential proxies. Free signup balance covers ~35K chrome requests.

### Tier 3 — CapSolver (paid, ~$1-3 per 1000 solves)
1. Go to https://www.capsolver.com in a real browser
2. Sign up — use promo code `CURL` for +6% balance
3. Add credit (minimum $10)
4. Get your API key from dashboard
5. Add to `.env`:
   ```
   CAPSOLVER_API_KEY=CAP-xxxxxxxxxxxx
   ```

### Alternative — Apify Jiji Scraper (paid, $2 / 1000 results)
If all the above fail, Apify has a ready-made Jiji scraper at
https://apify.com/stealth_mode/jiji-product-search-scraper. Sign up
(free tier $5/mo credit), search for "Jiji" in the store, run the actor.

---

## Monitoring

### Check FlareSolverr health
```bash
docker compose -f docker-compose.flaresolverr.yml ps
docker compose -f docker-compose.flaresolverr.yml logs --tail 100
```

### Check cookie vault
```bash
sqlite3 /path/to/db "SELECT domain, name, source, expiresAt, useCount, isValid FROM CookieVault ORDER BY expiresAt DESC LIMIT 10;"
```

### Check CF bypass stats
Hit the `/api/health` endpoint — it includes the output of `getCfBypassStatus()`:
```json
{
  "cfBypass": {
    "tier1FlareSolverr": true,
    "tier2SpiderCloud": true,
    "tier3CapSolver": false
  }
}
```

---

## Troubleshooting

### FlareSolverr returns 500 / "Challenge not solved"
- Increase `FLARESOLVERR_TIMEOUT_MS` to 90000
- Check FlareSolverr logs — may need to update Chrome
- Try restarting: `docker compose -f docker-compose.flaresolverr.yml restart`

### Cookie saved but jiji-client still gets 403
- Check that the User-Agent matches exactly (CF re-validates UA)
- Cookie may have expired — check `expiresAt` in CookieVault
- Cookie may be IP-bound to FlareSolverr's container IP, not host IP.
  Solution: run FlareSolverr with `network_mode: host` in docker-compose

### All tiers fail
- Check if jiji.co.ke changed their CF config (use `curl -v` to inspect headers)
- Check if our IP got HARD_BLOCKed (look for "Sorry, you have been blocked" in logs)
- If hard-blocked, need residential proxy — see `proxy-pool.ts`

---

## Cost Projection

| Tier | Cost | When used | Monthly estimate |
|------|------|-----------|------------------|
| Tier 1 (FlareSolverr) | FREE | ~95% of requests | $0 |
| Tier 2 (Spider.cloud) | $1/GB | ~5% of requests (FlareSolverr down) | ~$2-5 |
| Tier 3 (CapSolver) | $1-3 / 1000 | <1% of requests (both above fail) | ~$1-2 |
| **Total** | | | **~$3-7/month** |

For comparison: doing this without the tiered chain (i.e. calling CapSolver on
every request) would cost ~$50-150/month at our expected volume.
