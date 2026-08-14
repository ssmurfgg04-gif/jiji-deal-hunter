import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  validateProxies,
  seedProxyPool,
  seedDefaultProxies,
} from "@/lib/proxy-pool";

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
 * Body: { action: "seed_defaults" | "seed" | "validate", urls?: string[] }
 *
 *   action=seed_defaults — populate pool with built-in starter list
 *   action=seed          — add operator-supplied URLs (no validation)
 *   action=validate      — re-run validation on the pool (or supplied URLs)
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? "validate";

    if (action === "seed_defaults") {
      const result = await seedDefaultProxies();
      return NextResponse.json({
        ok: true,
        added: result.added,
        rejected: result.rejected,
        message: `${result.added} proxies added, ${result.rejected} rejected by SSRF guard. Call {action:"validate"} next.`,
      });
    }

    if (action === "seed") {
      const urls: string[] = body?.urls ?? [];
      if (urls.length === 0) {
        return NextResponse.json(
          { ok: false, error: "no urls supplied. Use action:'seed_defaults' for built-in list." },
          { status: 400 }
        );
      }
      const result = await seedProxyPool(urls);
      if (result.added === 0 && result.rejected > 0) {
        return NextResponse.json({
          ok: false,
          error: `All ${result.rejected} URLs rejected by SSRF guard. Only public http(s) URLs are allowed.`,
        }, { status: 400 });
      }
      return NextResponse.json({ ok: true, added: result.added, rejected: result.rejected });
    }

    // action === "validate"
    const all = await db.proxyPool.findMany({ select: { url: true } });
    const urls = body?.urls ?? all.map((p) => p.url);
    if (urls.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "pool is empty. POST {action:'seed_defaults'} first.",
        },
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
