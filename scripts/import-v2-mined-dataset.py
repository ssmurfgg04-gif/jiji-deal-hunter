#!/usr/bin/env python3
"""
Import the v2 REAL mined dataset (21,283 rows) into the DB.

Source: https://github.com/ssmurfgg04-gif/jiji-wayback-dataset
        data/jiji_mined_dataset_20260814_182449.csv

This is REAL data mined from Wayback Machine + Common Crawl archives.
It is NOT synthetic — the v1 dataset (jiji_wayback_dataset_*.csv) was
synthetic with seed=42; we explicitly skip that one.

Pipeline:
  1. Insert Sellers (one per unique seller_id, or per phone if no seller_id)
  2. Insert Listings (one per row, by marketId+guid)
  3. Insert PriceSnapshots (first_seen, last_seen when present)
  4. Resolve CanonicalItems from PriceSnapshot time series

Idempotent: re-running skips listings already present.
"""

import csv
import sqlite3
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

REPO = Path("/home/z/my-project/work/jiji-deal-hunter")
CSV_PATH = Path("/home/z/my-project/tools/jiji-wayback-dataset/data/jiji_mined_dataset_20260814_182449.csv")
DB_PATH = Path("/home/z/my-project/db/custom.db")

MARKET_CURRENCIES = {"ke": "KES", "ng": "NGN", "tz": "TZS", "ug": "UGX", "gh": "GHS"}
MARKET_BASES = {
    "ke": "https://jiji.co.ke",
    "ng": "https://jiji.ng",
    "tz": "https://jiji.co.tz",
    "ug": "https://jiji.ug",
    "gh": "https://jiji.com.gh",
}


def num(s, fallback=0):
    if s is None or s == "":
        return fallback
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return fallback


def fnum(s, fallback=0.0):
    if s is None or s == "":
        return fallback
    try:
        return float(s)
    except (ValueError, TypeError):
        return fallback


def parse_date(s):
    """Parse 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' → datetime (UTC)."""
    if not s or not s.strip():
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def iso(dt):
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    if not CSV_PATH.exists():
        print(f"FATAL: {CSV_PATH} not found", file=sys.stderr)
        sys.exit(1)
    if not DB_PATH.exists():
        print(f"FATAL: {DB_PATH} not found", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    cur = conn.cursor()

    # Stats
    stats = defaultdict(int)

    # Pre-fetch existing listing IDs + seller IDs to skip duplicates
    existing_listings = set()
    for row in cur.execute("SELECT id FROM Listing"):
        existing_listings.add(row[0])
    existing_sellers = set()
    for row in cur.execute("SELECT id FROM Seller"):
        existing_sellers.add(row[0])

    # Pre-fetch existing PriceSnapshot keys
    existing_snapshots = set()
    for row in cur.execute("SELECT marketId, itemId, captureTimestamp FROM PriceSnapshot"):
        existing_snapshots.add(row)

    print(f"[import] Reading {CSV_PATH}...")
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    print(f"[import] {len(rows)} rows to process")
    print(f"[import] Pre-existing: {len(existing_listings)} listings, {len(existing_sellers)} sellers, {len(existing_snapshots)} snapshots")

    # Phase 1: Build sellers + listings + snapshots
    seller_cache = {}  # (marketId, numericUserId) → sellerId

    batch_listings = []
    batch_sellers = []
    batch_snapshots = []

    for i, row in enumerate(rows):
        if i % 5000 == 0:
            print(f"  [progress] {i}/{len(rows)} rows processed")

        market_id = (row.get("country") or "").strip().lower()
        if market_id not in MARKET_CURRENCIES:
            stats["skipped_bad_market"] += 1
            continue

        guid = (row.get("guid") or "").strip()
        if not guid:
            stats["skipped_no_guid"] += 1
            continue

        # Build seller
        seller_id_raw = (row.get("seller_id") or "").strip()
        phone = (row.get("phone") or "").strip()
        seller_name = (row.get("seller_name") or "").strip() or "Unknown"

        if seller_id_raw:
            try:
                numeric_user_id = int(seller_id_raw)
            except ValueError:
                numeric_user_id = abs(hash(seller_id_raw)) % 10_000_000
        else:
            # No seller_id — derive from phone (or skip if no phone either)
            if phone:
                numeric_user_id = abs(hash(phone)) % 10_000_000
            else:
                # Use guid as last resort — each listing gets its own pseudo-seller
                numeric_user_id = abs(hash(f"{market_id}:{guid}")) % 10_000_000

        seller_pk = f"{market_id}-{numeric_user_id}"

        if seller_pk not in existing_sellers and seller_pk not in seller_cache:
            seller_cache[seller_pk] = True
            batch_sellers.append((
                seller_pk,
                market_id,
                numeric_user_id,
                seller_name[:200],
                None,  # location
                0,     # accountAgeDays
                num(row.get("adverts_count")) or 1,  # totalListings
                num(row.get("adverts_count")),
                num(row.get("feedback_count")),
                fnum(row.get("rating")),
                False,  # hidePhone
                1 if phone else 0,  # phoneLeaked
                phone,
                False,  # verifiedBadge
                # Computed: isDealer when adverts_count > 50 OR adverts/feedback > 5
                1 if (num(row.get("adverts_count")) > 50) else 0,
            ))

        # Build listing
        listing_pk = f"{market_id}-{guid}"
        if listing_pk in existing_listings:
            stats["skipped_existing_listing"] += 1
            # Still try to add snapshots if missing
        else:
            price = int(fnum(row.get("price")) * 100)  # store as cents? No — original schema is BigInt in raw units
            # Actually looking at schema: price is BigInt in raw units. The CSV price is already in local currency.
            price_int = int(fnum(row.get("price")))

            title = (row.get("title") or "").strip() or "Untitled"
            category_name = (row.get("category_name") or "").strip()
            base_url = MARKET_BASES[market_id]
            listing_url = f"{base_url}/listing/{guid}"

            boost_badge = (row.get("boost_badge") or "").strip()
            is_boost = 1 if boost_badge.lower() in ("top", "boost", "urgent") else 0

            first_seen_dt = parse_date(row.get("first_seen"))
            last_seen_dt = parse_date(row.get("last_seen"))
            days_listed = num(row.get("days_listed"))
            if not days_listed and first_seen_dt and last_seen_dt:
                days_listed = (last_seen_dt - first_seen_dt).days

            batch_listings.append((
                listing_pk,
                market_id,
                guid,
                title[:500],
                price_int,
                MARKET_CURRENCIES[market_id],
                category_name[:200] or "uncategorized",
                None,  # categoryId
                "new",  # condition (unknown)
                None,  # location
                None,  # imageUrl
                num(row.get("image_url_count")),
                num(row.get("count_views")),
                num(row.get("fav_count")),
                days_listed,
                listing_url,
                "active",  # status
                None,  # statusColor
                iso(first_seen_dt) if first_seen_dt else None,
                None,  # dateEdited
                None,  # dateModerated
                0,  # soldReported
                0,  # canMakeOffer
                0,  # abuseReported
                is_boost,
                None,  # paidInfo
                0,  # availableTopsCount
                None,  # priceValuationLow
                None,  # priceValuationHigh
                None,  # priceValuationLabel
                None,  # priceValuationUrl
                seller_pk,
                None,  # deletedAt
                iso(last_seen_dt) if last_seen_dt else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            ))
            existing_listings.add(listing_pk)
            stats["listings_added"] += 1

        # Build snapshots — for temporal signal
        # First snapshot = first_seen (with price_first)
        # Last snapshot = last_seen (with price_last) — only if different timestamp
        for ts_str, price_str, src_label in [
            (row.get("first_seen"), row.get("price_first"), "wayback"),
            (row.get("last_seen"), row.get("price_last"), "wayback"),
        ]:
            ts_dt = parse_date(ts_str)
            if ts_dt is None:
                continue
            price_val = int(fnum(price_str))
            if price_val <= 0:
                continue
            ts_iso = ts_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            snap_key = (market_id, guid, ts_iso)
            if snap_key in existing_snapshots:
                stats["snapshots_skipped_existing"] += 1
                continue
            batch_snapshots.append((
                market_id,
                guid,
                price_val,
                MARKET_CURRENCIES[market_id],
                (row.get("category_name") or "")[:200] or None,
                ts_iso,
                f"{MARKET_BASES[market_id]}/listing/{guid}",
                src_label,
                (row.get("title") or "")[:200] or None,
            ))
            existing_snapshots.add(snap_key)
            stats["snapshots_added"] += 1

        # Flush batches periodically
        if len(batch_listings) >= 500 or len(batch_sellers) >= 500 or len(batch_snapshots) >= 1000:
            flush(cur, batch_sellers, batch_listings, batch_snapshots)
            batch_sellers.clear()
            batch_listings.clear()
            batch_snapshots.clear()

    # Final flush
    flush(cur, batch_sellers, batch_listings, batch_snapshots)
    conn.commit()

    print()
    print("=" * 60)
    print("IMPORT COMPLETE — stats:")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")

    # Final counts
    for table in ["Seller", "Listing", "PriceSnapshot"]:
        cnt = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  TOTAL {table}: {cnt}")

    conn.close()


def flush(cur, sellers, listings, snapshots):
    if sellers:
        # Match exactly 22 columns (id, marketId, numericUserId, username, location,
        # accountAgeDays, totalListings, advertsCount, feedbackCount, rating,
        # hidePhone, phoneLeaked, phone, verifiedBadge, isDealer,
        # nicheScore, categoryDominance, responseTimeHours, memberSinceYear,
        # scoutEnrichedAt, createdAt, updatedAt)
        cur.executemany(
            """INSERT OR IGNORE INTO Seller
            (id, marketId, numericUserId, username, location, accountAgeDays,
             totalListings, advertsCount, feedbackCount, rating, hidePhone,
             phoneLeaked, phone, verifiedBadge, isDealer,
             nicheScore, categoryDominance, responseTimeHours, memberSinceYear,
             scoutEnrichedAt, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, NULL,NULL,NULL,NULL,NULL, datetime('now'), datetime('now'))""",
            sellers,
        )
    if listings:
        cur.executemany(
            """INSERT OR IGNORE INTO Listing
            (id, marketId, guid, title, price, currency, category, categoryId,
             condition, location, imageUrl, imageCount, views, favCount,
             daysOnMarket, url, status, statusColor, dateCreated, dateEdited,
             dateModerated, soldReported, canMakeOffer, abuseReported, isBoost,
             paidInfo, availableTopsCount, priceValuationLow, priceValuationHigh,
             priceValuationLabel, priceValuationUrl, sellerId, deletedAt, lastSeenAt,
             collectedAt, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?, ?, datetime('now'), datetime('now'), datetime('now'))""",
            listings,
        )
    if snapshots:
        cur.executemany(
            """INSERT OR IGNORE INTO PriceSnapshot
            (id, marketId, itemId, price, currency, categorySlug,
             captureTimestamp, captureUrl, source, pageTitle, createdAt)
            VALUES (lower(hex(randomblob(8))), ?,?,?,?,?, ?,?,?, ?, datetime('now'))""",
            snapshots,
        )


if __name__ == "__main__":
    main()
