/**
 * Next.js instrumentation hook — called once on server boot.
 *
 * We use it to:
 *   1. Seed the proxy pool with a starter list (if pool is empty).
 *   2. Start the auto-collection scheduler (every 30 minutes by default).
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { db } = await import("./src/lib/db");
    const { startScheduler } = await import("./src/lib/scheduler");
    const { seedDefaultProxies } = await import("./src/lib/proxy-pool");

    // 1. Seed the proxy pool with defaults if empty (idempotent).
    try {
      const count = await db.proxyPool.count();
      if (count === 0) {
        const added = await seedDefaultProxies();
         
        console.log(`[proxies] Seeded ${added} default proxies`);
      }
    } catch (e) {
       
      console.warn("[proxies] Failed to seed default proxies:", e);
    }

    // 2. Start the auto-collection scheduler.
    startScheduler();
     
    console.log("[scheduler] Auto-collection scheduler started");
  }
}
