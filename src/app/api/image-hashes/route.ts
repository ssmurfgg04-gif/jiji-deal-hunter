import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { topDuplicateHashes, findHashDuplicates } from "@/lib/image-hash";

/**
 * GET /api/image-hashes
 *
 * Returns the top duplicate image hashes — surfaces scam rings (same photo
 * across different sellers) and cross-market brokers (same photo across
 * Kenya + Nigeria etc).
 *
 * Query params:
 *   minSellers=2  — only show hashes appearing under 2+ sellers
 *   limit=50      — cap results
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const minSellers = parseInt(url.searchParams.get("minSellers") ?? "2", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

  const dupes = await topDuplicateHashes(limit);

  // Filter to only hashes with 2+ sellers (scam-ring signal)
  const filtered = dupes.filter((d) => d.sellerCount >= minSellers);

  return NextResponse.json({
    ok: true,
    count: filtered.length,
    totalHashes: dupes.length,
    duplicates: filtered,
  });
}

/**
 * POST /api/image-hashes
 * Body: { hash: string }
 *
 * Returns full duplicate report for a specific hash — all sellers, listings,
 * markets, and the duplicate-type flags (relist, cross-seller, cross-market).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const hash = body?.hash;
  if (!hash) {
    return NextResponse.json({ ok: false, error: "missing hash" }, { status: 400 });
  }
  const report = await findHashDuplicates(hash);
  if (!report) {
    return NextResponse.json({ ok: false, error: "hash not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, report });
}
