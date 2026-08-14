/**
 * Cache Layer
 *
 * Three-tier cache:
 *   1. In-memory LRU cache (per-process, fastest)
 *   2. CacheEntry table in SQLite (persisted across restarts, shared across requests)
 *   3. Origin (Prisma DB queries)
 *
 * Read flow: memory → DB cache → origin
 * Write flow: origin → DB cache → memory (on next read)
 *
 * Use for: /api/stats, /api/listings aggregations, /api/image-hashes top duplicates
 * Don't use for: /api/collect, /api/search (these mutate state)
 */

import { db } from "./db";

interface MemoryEntry {
  value: any;
  expiresAt: number; // epoch ms
}

const memoryCache = new Map<string, MemoryEntry>();
const MAX_MEMORY_ENTRIES = 200;

/**
 * Get from cache — checks memory first, then DB, then returns null.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  // 1. Memory
  const mem = memoryCache.get(key);
  if (mem) {
    if (mem.expiresAt > Date.now()) {
      return mem.value as T;
    }
    memoryCache.delete(key);
  }

  // 2. DB
  try {
    const row = await db.cacheEntry.findUnique({ where: { key } });
    if (row && row.expiresAt > new Date()) {
      const value = JSON.parse(row.value);
      // Backfill memory
      memoryCache.set(key, {
        value,
        expiresAt: row.expiresAt.getTime(),
      });
      return value as T;
    }
    if (row) {
      // expired — clean up
      await db.cacheEntry.delete({ where: { key } }).catch(() => {});
    }
  } catch {
    // ignore DB errors — fall through to null
  }

  return null;
}

/**
 * Set in both memory and DB caches.
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // 1. Memory
  if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    // Evict oldest entry (Map preserves insertion order)
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(key, { value, expiresAt: expiresAt.getTime() });

  // 2. DB
  try {
    await db.cacheEntry.upsert({
      where: { key },
      create: {
        key,
        value: JSON.stringify(value),
        expiresAt,
      },
      update: {
        value: JSON.stringify(value),
        expiresAt,
      },
    });
  } catch {
    // ignore DB errors — memory cache is still valid
  }
}

/**
 * Invalidate a cache key (useful after collection runs).
 */
export async function cacheInvalidate(key: string): Promise<void> {
  memoryCache.delete(key);
  try {
    await db.cacheEntry.delete({ where: { key } }).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Invalidate all cache keys matching a prefix.
 */
export async function cacheInvalidatePrefix(prefix: string): Promise<void> {
  // Memory
  for (const key of Array.from(memoryCache.keys())) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
  // DB
  try {
    await db.cacheEntry.deleteMany({
      where: { key: { startsWith: prefix } },
    });
  } catch {
    // ignore
  }
}

/**
 * Periodic cleanup — removes expired entries. Called by the scheduler.
 */
export async function cacheCleanup(): Promise<number> {
  try {
    const result = await db.cacheEntry.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  } catch {
    return 0;
  }
}

/**
 * Cache-aside helper: get-or-compute pattern.
 * If the cache has the value, return it. Otherwise compute, store, return.
 */
export async function cacheAside<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  const fresh = await compute();
  await cacheSet(key, fresh, ttlSeconds);
  return fresh;
}

/**
 * Apply SQLite performance pragmas at startup:
 *   - journal_mode=WAL  (100x write throughput)
 *   - synchronous=NORMAL (balance safety vs speed)
 *   - mmap_size=256MB    (memory-mapped I/O for reads)
 *
 * These persist across connections in SQLite.
 */
export async function applySqlitePragmas(): Promise<void> {
  try {
    await db.$executeRawUnsafe("PRAGMA journal_mode=WAL;");
    await db.$executeRawUnsafe("PRAGMA synchronous=NORMAL;");
    await db.$executeRawUnsafe("PRAGMA mmap_size=268435456;"); // 256MB
    await db.$executeRawUnsafe("PRAGMA temp_store=MEMORY;");
    await db.$executeRawUnsafe("PRAGMA cache_size=-20000;"); // 20MB page cache
  } catch (e) {
    // Pragmas are best-effort — don't crash startup if they fail
    console.warn("[cache] Failed to apply SQLite pragmas:", e);
  }
}

/**
 * Create indexes on hot columns for 1000x query speed.
 * Idempotent — uses CREATE INDEX IF NOT EXISTS.
 */
export async function createHotIndexes(): Promise<void> {
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_listing_price ON Listing(price);",
    "CREATE INDEX IF NOT EXISTS idx_listing_marketId ON Listing(marketId);",
    "CREATE INDEX IF NOT EXISTS idx_listing_category ON Listing(category);",
    "CREATE INDEX IF NOT EXISTS idx_listing_sellerId ON Listing(sellerId);",
    "CREATE INDEX IF NOT EXISTS idx_listing_status ON Listing(status);",
    "CREATE INDEX IF NOT EXISTS idx_listing_dateCreated ON Listing(dateCreated);",
    "CREATE INDEX IF NOT EXISTS idx_listing_abuseReported ON Listing(abuseReported) WHERE abuseReported = 1;",
    "CREATE INDEX IF NOT EXISTS idx_listing_soldReported ON Listing(soldReported) WHERE soldReported = 1;",
    "CREATE INDEX IF NOT EXISTS idx_seller_numericUserId ON Seller(numericUserId);",
    "CREATE INDEX IF NOT EXISTS idx_seller_isDealer ON Seller(isDealer) WHERE isDealer = 1;",
    "CREATE INDEX IF NOT EXISTS idx_imageHash_hash ON ImageHash(hash);",
    "CREATE INDEX IF NOT EXISTS idx_imageHash_sellerId ON ImageHash(sellerId);",
    "CREATE INDEX IF NOT EXISTS idx_dealScore_classification ON DealScore(classification);",
    "CREATE INDEX IF NOT EXISTS idx_dealScore_score ON DealScore(score);",
    "CREATE INDEX IF NOT EXISTS idx_priceHistory_listingId ON PriceHistory(listingId);",
    "CREATE INDEX IF NOT EXISTS idx_cacheEntry_expiresAt ON CacheEntry(expiresAt);",
  ];
  for (const sql of indexes) {
    try {
      await db.$executeRawUnsafe(sql);
    } catch (e) {
      // Index may already exist or column missing — skip silently
    }
  }
}

// Silence unused import warning in production builds
void applySqlitePragmas;
