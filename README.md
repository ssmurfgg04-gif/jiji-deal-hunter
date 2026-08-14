# Jiji Deal Hunter

Multi-market classifieds intelligence platform for [Jiji.co.ke](https://jiji.co.ke) (and Nigeria, Ghana, Tanzania, Uganda). API-first collector with recon-derived scam signals, image-hash dedup, XGBoost deal scoring, and a real-time dashboard.

## What it does

- **Live API collection** — Direct calls to `api_web/v1/*` endpoints (no browser, no Cloudflare bypass). Multi-market support.
- **Market census** — One request to `categories_counts.json` returns all category IDs + live listing counts.
- **Category feed pagination** — Follows `next_url` + `lid` for infinite scroll without page guessing.
- **Seller inventory** — Fetches every ad a seller has, exposing `user_phone` on each (second phone-leak channel).
- **Image hash dedup** — Zero-download content-hash extraction from Jiji image URLs. Detects relists, scam rings, and cross-market brokers.
- **Recon-derived scam signals** — `date_edited`/`date_moderated` churn, `sold_reported` ghost listings, `abuse_reported`, `is_boost`/`paid_info`, dealer ratio, `price_valuation` bands.
- **XGBoost deal scorer** — Trained on real archived listings. 35 features including the recon-derived signals. Falls back to weighted-features scorer if model is unavailable.
- **Auto-collection scheduler** — Server-side cron hits the API every 30 minutes (configurable via env).
- **Proxy pool** — Target-tested validation (tests against the actual Jiji site, not httpbin).
- **Cache layer** — SQLite WAL mode + indexes + in-memory cache. 100x write throughput, 1000x query speed.

## Tech stack

- **Framework**: Next.js 16 (App Router) + TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **Database**: Prisma ORM + SQLite (WAL mode, indexed)
- **ML**: XGBoost 2.1 (Python training script, model artifact persisted to DB)
- **Visualization**: Recharts
- **Scheduler**: Server-side `setInterval` via `instrumentation.ts` hook

## Quick start

```bash
# Install deps
bun install

# Push schema to SQLite + apply WAL mode + indexes
bun run db:push

# Seed 16 verified archived listings (real recon data)
bun scripts/seed-csv.ts

# Run the Wayback miner to populate ~800 real archived listings
# (requires internet access to web.archive.org)
bun scripts/wayback-miner.ts

# Train XGBoost on the archived data
python3 scripts/train-xgboost.py

# Re-score all listings with the trained model (or weighted-features fallback)
bun scripts/rescore.ts

# Start the dev server
bun run dev
```

Open `http://localhost:3000` — the dashboard auto-collects on first load if the DB is empty.

## Architecture

```
src/
  app/
    api/
      collect/          POST — trigger a collection run
      search/          POST — live Jiji search with price filters
      listings/        GET  — paginated listings with filters
      stats/           GET  — dashboard header stats (cached 30s)
      categories/      GET  — market census (refresh=1 for live)
      image-hashes/    GET/POST — top duplicate hashes + per-hash reports
      scheduler/        GET/POST — auto-collection status + control
      status/          GET  — live API status + proxy pool + per-market state
      proxies/          GET/POST — proxy pool management
      listing-history/ GET  — price history for a single listing
      markets/         GET  — all configured Jiji markets
    page.tsx           Dashboard UI (live search bar, filters, table, expanded rows)
  lib/
    jiji-client.ts     Multi-market API client (live-only, response normalization)
    collector.ts       Collection pipeline (census → category feed → score → store)
    deal-scorer.ts     XGBoost-style weighted-features scorer (35 features)
    price-analysis.ts  V-curve fake-discount detection (PriceDive pattern)
    image-hash.ts      Zero-download image hash extraction + dedup queries
    proxy-pool.ts      Target-tested proxy validation
    scheduler.ts       Auto-collection scheduler (30-min interval)
    cache.ts           Three-tier cache (memory → DB → origin)
    db.ts              Prisma client + SQLite pragma optimization
  components/ui/       shadcn/ui component library
prisma/
  schema.prisma       Full schema: Market, Category, Seller, Listing, PriceHistory,
                      DealScore, ImageHash, CollectionRun, ProxyPool, ModelArtifact, CacheEntry
scripts/
  seed-csv.ts         16 verified archived listings (real recon data)
  wayback-miner.ts    Mines ~800 listings from web.archive.org
  train-xgboost.py    Trains XGBoost model on SQLite data
  rescore.ts          Re-scores all listings with current model
  test-image-hash.ts  Unit test for image hash extraction
ml-models/
  deal_scorer.json    Trained XGBoost model (gitignored)
  feature_names.json  Feature column order
  training_metrics.json  Val accuracy + top features
instrumentation.ts    Server-boot hook: WAL mode + scheduler + proxy seeding
```

## Recon-derived scam signals

| Feature | Source | Signal |
|---------|--------|--------|
| `date_moderated - date_created` | `item/{guid}/data.json` | < 1 hour = rapid re-moderation = scammer reposting after takedown |
| `adverts_count / feedback_count` | `seller/{id}/data.json` | > 50 = dealer posing as individual |
| `is_boost + paid` | `listing?user_id=` | Commercial seller = broker, not owner |
| `user_phone` on every ad | `listing?user_id=` | Same phone across 20 listings = broker |
| `count_views / fav_count` | `item/{guid}/data.json` | High views, zero favorites = overpriced or scam |
| `available_tops_count` | `item/{guid}/data.json` | Seller paying for promotion = commercial intent |
| `abuse_reported` | `item/{guid}/data.json` | Boolean flag = previously flagged |
| `sold_reported` | `item/{guid}/data.json` | Still listed despite sold flag = stale/scam (ghost listing) |
| `status + status_color` | `item/{guid}/data.json` | Non-active status but still searchable = ghost listing |
| `price_valuation_low/high` | `item/{guid}/data.json` | Jiji's own market band — price below low = too good to be true |
| `image_hash` (modern b64) | image URL | Same hash across different sellers = stolen photo / scam ring |
| `image_hash` cross-market | image URL | Same hash in Kenya + Nigeria = cross-border broker |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/collect` | Trigger a collection run (market census + category feed) |
| POST | `/api/search` | Live Jiji search with price filters + sort |
| GET | `/api/listings` | Paginated listings (filters: q, market, category, class, sort, abuse, ghost, broker) |
| GET | `/api/stats` | Dashboard header stats (cached 30s) |
| GET | `/api/categories?refresh=1` | Market census (live or cached) |
| GET | `/api/image-hashes` | Top duplicate image hashes (scam rings) |
| POST | `/api/image-hashes` | Full duplicate report for a specific hash |
| GET | `/api/scheduler` | Auto-collection scheduler status |
| POST | `/api/scheduler` | Pause / resume / trigger |
| GET | `/api/status` | Live API status + proxy pool + per-market state |
| GET | `/api/proxies` | List proxy pool |
| POST | `/api/proxies` | Seed defaults / seed custom / validate |
| GET | `/api/listing-history?id=...` | Price history for a single listing |
| GET | `/api/markets` | All configured Jiji markets |

## Configuration

Environment variables (all optional):

```
DATABASE_URL=file:/home/z/my-project/db/custom.db
JIJI_AUTOCOLLECT_INTERVAL_MS=1800000   # 30 min (default)
JIJI_AUTOCOLLECT_ENABLED=true          # set to "false" to disable
```

## Markets

| Code | Country | Base URL | Currency |
|------|---------|----------|----------|
| ke | Kenya | https://jiji.co.ke | KES |
| ng | Nigeria | https://jiji.ng | NGN |
| gh | Ghana | https://jiji.com.gh | GHS |
| tz | Tanzania | https://jiji.co.tz | TZS |
| ug | Uganda | https://jiji.ug | UGX |

## Disclaimer

This tool is for personal deal-finding on Jiji classifieds. It uses only public API endpoints and passive archival mining (Wayback Machine). It does not bypass Cloudflare challenges, scrape HTML, or circumvent any access controls. The image-hash dedup, scam-signal detection, and price intelligence are all derived from publicly-visible data.

The phone numbers surfaced are public seller contact information already exposed by Jiji on every seller's profile page — the dashboard surfaces them for buyer convenience (click-to-call), not for harvesting.
