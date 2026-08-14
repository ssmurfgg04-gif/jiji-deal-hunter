import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cacheAside } from "@/lib/cache";

/**
 * GET /api/seller-profile?id=<sellerId>
 *
 * Returns a seller's full profile: stats, all their listings, image
 * duplicate count, dealer classification, temporal data if available.
 *
 * Used by the seller profile view in the dashboard.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sellerId = url.searchParams.get("id");
  if (!sellerId) {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  }

  const cacheKey = `seller:${sellerId}`;

  try {
    const data = await cacheAside(cacheKey, 30, async () => {
      const seller = await db.seller.findUnique({
        where: { id: sellerId },
        include: {
          listings: {
            where: { deletedAt: null },
            select: {
              id: true,
              title: true,
              price: true,
              currency: true,
              category: true,
              condition: true,
              imageUrl: true,
              views: true,
              favCount: true,
              daysOnMarket: true,
              isBoost: true,
              abuseReported: true,
              soldReported: true,
              dateCreated: true,
              dealScore: {
                select: {
                  score: true,
                  classification: true,
                  sellerRisk: true,
                  hasFakeDiscount: true,
                  hasPhoneLeak: true,
                  imageDuplicateCount: true,
                },
              },
            },
            orderBy: { price: "desc" },
          },
          imageHashes: {
            select: { hash: true, hashType: true, listingId: true },
          },
        },
      });

      if (!seller) {
        return null;
      }

      // Check for image hash duplicates across this seller's listings
      const hashCounts = new Map<string, number>();
      for (const ih of seller.imageHashes) {
        const dupes = await db.imageHash.count({
          where: { hash: ih.hash, sellerId: { not: seller.id } },
        });
        if (dupes > 0) {
          hashCounts.set(ih.hash, dupes);
        }
      }

      return {
        seller: {
          id: seller.id,
          marketId: seller.marketId,
          numericUserId: seller.numericUserId,
          username: seller.username,
          location: seller.location,
          accountAgeDays: seller.accountAgeDays,
          totalListings: seller.totalListings,
          advertsCount: seller.advertsCount,
          feedbackCount: seller.feedbackCount,
          rating: seller.rating,
          hidePhone: seller.hidePhone,
          phoneLeaked: seller.phoneLeaked,
          phone: seller.phone,
          verifiedBadge: seller.verifiedBadge,
          isDealer: seller.isDealer,
          dealerRatio:
            seller.advertsCount / Math.max(seller.feedbackCount, 1),
        },
        listings: seller.listings.map((l) => ({
          ...l,
          price: Number(l.price),
        })),
        imageHashStats: {
          totalHashes: seller.imageHashes.length,
          sharedWithOtherSellers: hashCounts.size,
          sharedHashDetails: Array.from(hashCounts.entries()).slice(0, 10).map(
            ([hash, count]) => ({ hash, sharedWith: count })
          ),
        },
      };
    });

    if (!data) {
      return NextResponse.json(
        { ok: false, error: "seller not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "failed" },
      { status: 500 }
    );
  }
}
