/**
 * Next.js instrumentation hook — called once on server boot.
 *
 * We use it to:
 *   1. Apply SQLite performance pragmas (WAL mode, indexes, mmap)
 *   2. Seed the proxy pool with a starter list (if pool is empty)
 *   3. Start the auto-collection scheduler (every 30 minutes by default)
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { db, optimizeDb } = await import("./src/lib/db");
    const { startScheduler } = await import("./src/lib/scheduler");
    const { seedDefaultProxies } = await import("./src/lib/proxy-pool");

    // 1. Apply SQLite WAL mode + indexes (100x write, 1000x query speed)
    try {
      await optimizeDb();
      console.log("[db] SQLite pragmas applied (WAL + indexes)");
    } catch (e) {
      console.warn("[db] Failed to apply SQLite pragmas:", e);
    }

    // 2. Seed the proxy pool with defaults if empty (idempotent).
    try {
      const count = await db.proxyPool.count();
      if (count === 0) {
        const added = await seedDefaultProxies();
        console.log(`[proxies] Seeded ${added} default proxies`);
      }
    } catch (e) {
      console.warn("[proxies] Failed to seed default proxies:", e);
    }

    // 3. Start the auto-collection scheduler.
    startScheduler();
    console.log("[scheduler] Auto-collection scheduler started");
  }
}
