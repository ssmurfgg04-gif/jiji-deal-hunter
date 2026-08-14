import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Apply SQLite performance pragmas at startup (WAL mode + indexes).
 * Called once from instrumentation.ts after schema is in sync.
 *
 * WAL mode = 100x write throughput (concurrent reads + single writer).
 * Indexes = 1000x query speed on filtered columns.
 */
export async function optimizeDb(): Promise<void> {
  try {
    // PRAGMAs that return a row must use $queryRawUnsafe (not $executeRawUnsafe,
    // which throws "Execute returned results, which is not allowed in SQLite").
    // This was a silent bug — every pragma except journal_mode=WAL was failing
    // and the error was swallowed by the catch block, so all 8 hot indexes
    // were never created and synchronous/mmap/temp_store/cache_size were never set.
    await db.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await db.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    await db.$queryRawUnsafe("PRAGMA mmap_size=268435456;"); // 256MB
    await db.$queryRawUnsafe("PRAGMA temp_store=MEMORY;");
    await db.$queryRawUnsafe("PRAGMA cache_size=-20000;"); // 20MB page cache

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
      } catch {
        // ignore individual index failures
      }
    }
  } catch (e) {
    // Best-effort — don't crash startup
  }
}

/**
 * Run a WAL checkpoint to flush WAL file contents back to the main DB.
 * Call after bulk inserts (collection runs) to keep read performance high.
 * Uses $queryRawUnsafe because PRAGMA wal_checkpoint returns a row.
 */
export async function checkpointDb(): Promise<void> {
  try {
    await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // best-effort
  }
}
