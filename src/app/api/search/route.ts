import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jiji, MARKETS, type MarketId } from "@/lib/jiji-client";
import { medianPrice } from "@/lib/price-analysis";

/**
 * POST /api/search
 * Body: {
 *   q: string,
 *   marketId?: "ke" | "ng" | "gh" | "tz" | "ug" (default "ke"),
 *   minPrice?: number,
 *   maxPrice?: number,
 *   sort?: "new" | "price_asc" | "price_desc" | "relevance",
 *   persist?: boolean (default true — save results to DB)
 * }
 *
 * Hits Jiji's live /search endpoint with the operator's exact query + price
 * filters + sort. Returns matched listings and (by default) persists them
 * to the DB so they show up in the dashboard.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const q = (body?.q ?? "").trim();
    if (!q) {
      return NextResponse.json({ ok: false, error: "missing query" }, { status: 400 });
    }
    const marketId = (body?.marketId ?? "ke") as MarketId;
    if (!MARKETS.find((m) => m.id === marketId)) {
      return NextResponse.json({ ok: false, error: "invalid market" }, { status: 400 });
    }
    const minPrice = body?.minPrice != null ? Number(body.minPrice) : undefined;
    const maxPrice = body?.maxPrice != null ? Number(body.maxPrice) : undefined;
    const sort = body?.sort ?? "relevance";
    const persist = body?.persist !== false;

    const result = await jiji.search(marketId, { q, minPrice, maxPrice, sort });
    if (!result) {
      return NextResponse.json({
        ok: false,
        blocked: true,
        error: "Live API blocked (Cloudflare) or unreachable from this server.",
      });
    }

    let persistedCount = 0;
    if (persist) {
      // Compute market median per category for the new listings
      const byCategory: Record<string, number[]> = {};
      result.items.forEach((l) => {
        (byCategory[l.category] ??= []).push(l.price);
      });
      const medians: Record<string, number> = {};
      for (const [cat, prices] of Object.entries(byCategory)) {
        medians[cat] = medianPrice(prices);
      }

      for (const item of result.items) {
        try {
          // Upsert seller
          await db.seller.upsert({
            where: { id: item.seller.id },
            create: {
              id: item.seller.id,
              marketId: item.seller.marketId,
              numericUserId: item.seller.numericUserId,
              username: item.seller.username,
              location: item.seller.location,
              accountAgeDays: item.seller.account_age_days,
              totalListings: item.seller.total_items,
              advertsCount: item.seller.adverts_count,
              feedbackCount: item.seller.feedback_count,
              rating: item.seller.rating,
              hidePhone: item.seller.hide_phone,
              phoneLeaked: item.seller.hide_phone && !!item.seller.phone,
              phone: item.seller.phone,
              verifiedBadge: item.seller.verified_badge,
            },
            update: {},
          });

          // Upsert listing
          await db.listing.upsert({
            where: { id: item.id },
            create: {
              id: item.id,
              marketId: item.marketId,
              guid: item.guid,
              title: item.title,
              price: item.price,
              currency: item.currency,
              category: item.category,
              categoryId: item.category_id,
              condition: item.condition,
              location: item.location,
              imageUrl: item.images[0]?.url ?? null,
              imageCount: item.images.length,
              views: item.views,
              favCount: item.fav_count,
              daysOnMarket: item.days_on_market,
              url: item.url,
              status: item.status,
              statusColor: item.status_color,
              dateCreated: item.date_created ? new Date(item.date_created) : null,
              dateEdited: item.date_edited ? new Date(item.date_edited) : null,
              dateModerated: item.date_moderated ? new Date(item.date_moderated) : null,
              soldReported: item.sold_reported,
              canMakeOffer: item.can_make_an_offer,
              abuseReported: item.abuse_reported,
              isBoost: item.is_boost,
              paidInfo: item.paid_info ? JSON.stringify(item.paid_info) : null,
              availableTopsCount: item.available_tops_count,
              sellerId: item.seller.id,
              priceHistory: {
                create: item.price_history.map((p) => ({
                  price: p.price,
                  recordedAt: new Date(p.recorded_at),
                })),
              },
            },
            update: {},
          });
          persistedCount++;
        } catch (e) {
          // skip individual failures
        }
      }
    }

    return NextResponse.json({
      ok: true,
      marketId,
      q,
      count: result.items.length,
      total: result.total,
      persisted: persistedCount,
      items: result.items.map((l) => ({
        id: l.id,
        title: l.title,
        price: l.price,
        currency: l.currency,
        category: l.category,
        condition: l.condition,
        location: l.location,
        imageUrl: l.images[0]?.url ?? null,
        url: l.url,
        marketMedian: medianPrice(result.items.filter((x) => x.category === l.category).map((x) => x.price)),
        seller: {
          id: l.seller.id,
          username: l.seller.username,
          phone: l.seller.phone,
          hidePhone: l.seller.hide_phone,
          phoneLeaked: l.seller.hide_phone && !!l.seller.phone,
          verifiedBadge: l.seller.verified_badge,
          advertsCount: l.seller.adverts_count,
          feedbackCount: l.seller.feedback_count,
        },
      })),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "search failed" },
      { status: 500 }
    );
  }
}
