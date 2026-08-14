import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateProxies, seedProxyPool } from "@/lib/proxy-pool";

/**
 * GET /api/proxies — list all proxies in pool with their last test result.
 */
export async function GET() {
  const proxies = await db.proxyPool.findMany({
    orderBy: [{ isWorking: "desc" }, { latencyMs: "asc" }],
  });
  const working = proxies.filter((p) => p.isWorking).length;
  return NextResponse.json({ total: proxies.length, working, proxies });
}

/**
 * POST /api/proxies
 * Body: { urls?: string[], action: "validate" | "seed" }
 *
 *   action=seed     — add URLs to the pool (no validation)
 *   action=validate — re-run validation on the entire pool
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? "validate";

    if (action === "seed") {
      const urls: string[] = body?.urls ?? [];
      const added = await seedProxyPool(urls);
      return NextResponse.json({ ok: true, added });
    }

    // Validate existing pool
    const all = await db.proxyPool.findMany({ select: { url: true } });
    const urls = body?.urls ?? all.map((p) => p.url);
    if (urls.length === 0) {
      return NextResponse.json(
        { ok: false, error: "pool is empty. POST {action:'seed', urls:[...]} first." },
        { status: 400 }
      );
    }
    const results = await validateProxies(urls);
    const working = results.filter((r) => r.working).length;
    return NextResponse.json({ ok: true, tested: results.length, working, results });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "proxy operation failed" },
      { status: 500 }
    );
  }
}
