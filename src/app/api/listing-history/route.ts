import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/listing-history?id=<listingId>
 *
 * Returns the price history for a single listing — used by the inline
 * sparkline chart when a row is expanded.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  const history = await db.priceHistory.findMany({
    where: { listingId: id },
    orderBy: { recordedAt: "asc" },
  });

  const listing = await db.listing.findUnique({
    where: { id },
    include: { seller: true, dealScore: true },
  });

  if (!listing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    listing: {
      id: listing.id,
      title: listing.title,
      currentPrice: Number(listing.price),
      category: listing.category,
      condition: listing.condition,
      url: listing.url,
    },
    seller: listing.seller,
    score: listing.dealScore,
    history: history.map((h) => ({
      price: Number(h.price),
      recordedAt: h.recordedAt,
    })),
  });
}
