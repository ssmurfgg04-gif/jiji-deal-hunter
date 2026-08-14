import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { topDuplicateHashes, findHashDuplicates } from "@/lib/image-hash";
import { cacheAside } from "@/lib/cache";

/**
 * GET /api/scam-rings
 *
 * Returns image hash duplicates — groups of listings sharing the same
 * photo content hash across different sellers (= stolen photos / scam rings).
 *
 * This is the unique fraud signal: zero-download image hash dedup detects
 * when the same photo appears under different seller accounts.
 *
 * Query params:
 *   minSellers=2 — only show hashes appearing under 2+ sellers
 *   limit=50      — cap results
 *   detail=1      — include full duplicate report per hash (sellers, listings, markets)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const minSellers = parseInt(url.searchParams.get("minSellers") ?? "2", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const withDetail = url.searchParams.get("detail") === "1";

  const cacheKey = `scam-rings:${minSellers}:${limit}:${withDetail}`;

  const data = await cacheAside(cacheKey, 60, async () => {
    const dupes = await topDuplicateHashes(limit);
    const filtered = dupes.filter((d) => d.sellerCount >= minSellers);

    if (!withDetail) {
      return {
        count: filtered.length,
        scamRings: filtered,
      };
    }

    // Fetch full detail per hash
    const detailed = await Promise.all(
      filtered.slice(0, 20).map(async (d) => {
        const report = await findHashDuplicates(d.hash);
        return {
          ...d,
          report,
        };
      })
    );

    return {
      count: filtered.length,
      scamRings: detailed,
    };
  });

  return NextResponse.json(data);
}
