import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runCollection } from "@/lib/collector";

/**
 * POST /api/collect
 * Body: { queries?: string[], sourceMode?: "api" | "browser" }
 *
 * Triggers a fresh collection sweep. Idempotent — running it again will
 * refresh existing listings and add new ones.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const summary = await runCollection({
      queries: body?.queries,
      sourceMode: body?.sourceMode ?? "api",
    });
    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "collection failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/collect — returns the last N collection runs.
 */
export async function GET() {
  const runs = await db.collectionRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  return NextResponse.json({ runs });
}
