#!/usr/bin/env bun
/**
 * Seed the 16-row verified CSV from recon.
 *
 * Real archived data, hand-extracted from raw Wayback bodies by the recon AI.
 * Every field is from the actual archived response. Image URLs semicolon-joined.
 *
 * This is the bootstrap dataset — small but 100% real. Use it to validate the
 * schema end-to-end and as a smoke test for the scorer.
 *
 * Usage: bun scripts/seed-csv.ts
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const MARKET_ID = "ke" as const;
const MARKET_BASE = "https://jiji.co.ke";

interface SeedRow {
  guid: string;
  title: string;
  price: number;
  date_created: string | null;
  date_moderated: string | null;
  date_edited: string | null;
  seller_id: number;
  seller_name: string;
  phone: string;
  category_id: number;
  category_name: string;
  count_views: number | null;
  fav_count: number | null;
  adverts_count: number | null;
  feedback_count: number | null;
  rating: number | null;
  boost_badge: string;
  capture_ts: string;
  image_urls: string;
}

// The 16 verified rows from recon
const SEED_ROWS: SeedRow[] = [
  {
    guid: "3jbzkFYYsnsOeoDhecPsciyH",
    title: "Flats For Sale In Witeithie Along Thika Road",
    price: 17000000,
    date_created: "Sat, 28 Mar 2020 07:24:48 GMT",
    date_moderated: "Sun, 26 Apr 2020 07:03:10 GMT",
    date_edited: "Sun, 26 Apr 2020 07:03:10 GMT",
    seller_id: 2219080,
    seller_name: "Irene Ndambiri",
    phone: "0715446987",
    category_id: 46,
    category_name: "Commercial Property For Sale",
    count_views: 417,
    fav_count: null,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-05-09",
    image_urls: "https://ke3.jijistatic.com/7770622_img-20200325-wa1079_300x400.jpg;https://ke2.jijistatic.com/7770645_img-20200325-wa1086_300x400.jpg",
  },
  {
    guid: "30TFxradr3oasbNSLbQraaPl",
    title: "Residential Home",
    price: 4900000,
    date_created: "Sat, 18 Apr 2020 08:26:15 GMT",
    date_moderated: "Mon, 20 Apr 2020 22:51:09 GMT",
    date_edited: "Mon, 20 Apr 2020 22:51:09 GMT",
    seller_id: 2065177,
    seller_name: "Penniel Jonny",
    phone: "0721166780",
    category_id: 46,
    category_name: "Commercial Property For Sale",
    count_views: 262,
    fav_count: null,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-05-09",
    image_urls: "https://d22wk3bxdr1ulp.cloudfront.net/8173340_img-20200413-133329-4_300x240.jpg;https://d22wk3bxdr1ulp.cloudfront.net/8173362_img-20200413-131846-6_300x240.jpg",
  },
  {
    guid: "kRYdkPBnkshRovcSVJilXq5o",
    title: "Riara Front Passie",
    price: 15000000,
    date_created: "Sun, 03 May 2020 13:51:15 GMT",
    date_moderated: "Sun, 03 May 2020 16:15:21 GMT",
    date_edited: null,
    seller_id: 213349,
    seller_name: "Martin Gitau",
    phone: "0770820696",
    category_id: 46,
    category_name: "Commercial Property For Sale",
    count_views: 28,
    fav_count: 0,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-05-09",
    image_urls: "https://d22wk3bxdr1ulp.cloudfront.net/8493265_thumbnail_300x150.jpg;https://d22wk3bxdr1ulp.cloudfront.net/8493313_thumbnail1_300x150.jpg",
  },
  {
    guid: "3XHksAFVQ2rvYaXh5KjcBssc",
    title: "Mitsubishi Shogun 1995 Silver",
    price: 230000,
    date_created: "Tue, 05 May 2020 19:39:08 GMT",
    date_moderated: "Sat, 09 May 2020 16:51:04 GMT",
    date_edited: null,
    seller_id: 2384839,
    seller_name: "Akyllah Hawi",
    phone: "0710441408",
    category_id: 29,
    category_name: "Cars",
    count_views: 785,
    fav_count: 4,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-07-27",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/8614122_img-20200508-wa0039_300x225.jpg;https://d12prgon3aw7l1.cloudfront.net/8614118_img-20200508-wa0047_300x225.jpg",
  },
  {
    guid: "kHBc6Up2Uq5ouyaSFKoJbCtX",
    title: "Mitsubishi Pajero 1995 Gray",
    price: 530000,
    date_created: "Thu, 02 Jan 2020 07:12:55 GMT",
    date_moderated: "Sun, 02 Aug 2020 17:38:06 GMT",
    date_edited: "Sun, 02 Aug 2020 17:38:06 GMT",
    seller_id: 492017,
    seller_name: "John Mururu",
    phone: "0721571461",
    category_id: 29,
    category_name: "Cars",
    count_views: 1246,
    fav_count: 18,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-08-02",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/5477693_20200102-101150_300x225.jpg;https://d12prgon3aw7l1.cloudfront.net/5477698_20200102-101234_300x225.jpg",
  },
  {
    guid: "wwbycDaUyGyO4KM2d8jvNNb9",
    title: "Mitsubishi Pajero 1998 Blue",
    price: 320000,
    date_created: "Sat, 18 Jan 2020 15:48:58 GMT",
    date_moderated: "Mon, 03 Aug 2020 09:10:19 GMT",
    date_edited: "Mon, 03 Aug 2020 09:10:19 GMT",
    seller_id: 1945852,
    seller_name: "Kahiu Jos",
    phone: "0722754106",
    category_id: 29,
    category_name: "Cars",
    count_views: 5110,
    fav_count: null,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2020-08-03",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/11010457_img-20200730-172840-0_300x225.jpg;https://d12prgon3aw7l1.cloudfront.net/11010469_img-20200730-173028-9_300x225.jpg",
  },
  {
    guid: "s5nkBitC5MqoLDmEx0p0Sqpe",
    title: "Geforce RTX 2070 8GB XLR8 Gaming Overclocked Graphics Card",
    price: 115000,
    date_created: "Mon, 16 Dec 2019 08:49:17 GMT",
    date_moderated: "Tue, 06 Oct 2020 20:14:45 GMT",
    date_edited: "Tue, 06 Oct 2020 20:14:45 GMT",
    seller_id: 842289,
    seller_name: "Toney - Starcom",
    phone: "0720384084",
    category_id: 284,
    category_name: "Computer Hardware",
    count_views: 129,
    fav_count: 3,
    adverts_count: null,
    feedback_count: 1,
    rating: 100,
    boost_badge: "",
    capture_ts: "2020-10-07",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/5178543_nvidia-gtx-2070_300x300.jpg;https://d12prgon3aw7l1.cloudfront.net/5178545_rtx2070_300x227.jpg",
  },
  {
    guid: "zX4xRYuITgxvONDhn6Vjgwwu",
    title: "Sony Playstation",
    price: 2000,
    date_created: "Fri, 25 Sep 2020 20:52:19 GMT",
    date_moderated: "Mon, 11 Jan 2021 16:57:53 GMT",
    date_edited: "Mon, 11 Jan 2021 14:43:03 GMT",
    seller_id: 1051381,
    seller_name: "Roy Demeyo",
    phone: "0724361962",
    category_id: 19,
    category_name: "Video Game Consoles",
    count_views: 210,
    fav_count: 4,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2021-01-16",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/12920994_img-20200930-060148_300x400.jpg;https://d12prgon3aw7l1.cloudfront.net/12920995_img-20200930-060227_300x225.jpg",
  },
  {
    guid: "iLzYBUwHLSyvkbdUWhq1tY89",
    title: "Volkswagen Golf 2008 1.4 FSi Sportline Gray",
    price: 680000,
    date_created: null,
    date_moderated: null,
    date_edited: null,
    seller_id: 2815109,
    seller_name: "Grinshin Demoree",
    phone: "0725488683",
    category_id: 29,
    category_name: "Cars",
    count_views: null,
    fav_count: null,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2021-04-21",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/13978521_20201024-205728_300x225.jpg;https://d12prgon3aw7l1.cloudfront.net/13978537_20201024-205915_300x286.jpg",
  },
  {
    guid: "mgRrQhlqhe4q2qcirI6gNRwq",
    title: "Audi A3 2007 Silver",
    price: 719000,
    date_created: null,
    date_moderated: null,
    date_edited: null,
    seller_id: 1381173,
    seller_name: "Alfred - Grandeur Cars Sellers",
    phone: "0725636274",
    category_id: 29,
    category_name: "Cars",
    count_views: null,
    fav_count: null,
    adverts_count: null,
    feedback_count: 2,
    rating: 40,
    boost_badge: "",
    capture_ts: "2021-04-26",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/18463214_img-20210324-165520_300x261.jpg;https://d12prgon3aw7l1.cloudfront.net/18452922_img-20210319-wa0038_300x400.jpg",
  },
  {
    guid: "yVrhtUzGrMnBX9IUoHlEJzs",
    title: "Charge Controller, Avs30, Linier Avs 30",
    price: 2500,
    date_created: "Wed, 08 Jan 2020 11:35:43 GMT",
    date_moderated: "Fri, 28 May 2021 03:06:59 GMT",
    date_edited: "Fri, 28 May 2021 03:06:59 GMT",
    seller_id: 1948825,
    seller_name: "jostim electricals",
    phone: "0712431201",
    category_id: 297,
    category_name: "Electrical Equipment",
    count_views: 1,
    fav_count: 0,
    adverts_count: null,
    feedback_count: null,
    rating: null,
    boost_badge: "",
    capture_ts: "2021-05-28",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/5653034_img-20200108-123526-888_300x400.jpg;https://d12prgon3aw7l1.cloudfront.net/5653052_img-20200108-123621-141_300x400.jpg",
  },
  {
    guid: "wONBZGjwyZjnBNkCPj8OBRqW",
    title: "12v 200ah Drom Power Battery",
    price: 29000,
    date_created: "Wed, 23 Dec 2020 10:48:47 GMT",
    date_moderated: "Thu, 27 May 2021 08:23:42 GMT",
    date_edited: "Thu, 27 May 2021 08:23:42 GMT",
    seller_id: 1938973,
    seller_name: "Damaris Nyaibari",
    phone: "0724986684",
    category_id: 272,
    category_name: "Solar Energy",
    count_views: 26,
    fav_count: 0,
    adverts_count: null,
    feedback_count: 3,
    rating: 73,
    boost_badge: "",
    capture_ts: "2021-05-27",
    image_urls: "https://d12prgon3aw7l1.cloudfront.net/15680555_fb-img-1608119577058_300x300.jpg",
  },
  {
    guid: "l9Uuz6RHEH2f28dRsARDd25c",
    title: "Land Rover Range Rover Vogue 1995 Blue",
    price: 900000,
    date_created: "Sat, 11 Dec 2021 07:47:10 GMT",
    date_moderated: "Sat, 11 Dec 2021 08:19:43 GMT",
    date_edited: "Sat, 11 Dec 2021 08:04:55 GMT",
    seller_id: 1953550,
    seller_name: "Kei Cars Ltd",
    phone: "",
    category_id: 29,
    category_name: "Cars",
    count_views: 140,
    fav_count: null,
    adverts_count: 50,
    feedback_count: 0,
    rating: null,
    boost_badge: "",
    capture_ts: "2021-12-14",
    image_urls: "https://pictures-kenya.jijistatic.com/28728504_MzAwLTIyNS1lZGQyYzRjNTYx.jpg;https://pictures-kenya.jijistatic.com/28728499_MzAwLTIyNS1lMzFhZmJjMmE4.jpg",
  },
  {
    guid: "hzUmLP5b3kC4ZmCpTZKcqZ8y",
    title: "Ford Mondeo 2.0 TDCi Ambiente 2011 White",
    price: 1100000,
    date_created: "Sat, 09 Apr 2022 15:05:00 GMT",
    date_moderated: null,
    date_edited: "Tue, 07 Jun 2022 13:50:01 GMT",
    seller_id: 364337,
    seller_name: "Vickie Muigai",
    phone: "",
    category_id: 29,
    category_name: "Cars",
    count_views: 473,
    fav_count: null,
    adverts_count: 41,
    feedback_count: 4,
    rating: null,
    boost_badge: "",
    capture_ts: "2023-03-06",
    image_urls: "https://pictures-kenya.jijistatic.com/33276806_MzAwLTI2OS1jMTZiZTdiMGU5.jpg;https://pictures-kenya.jijistatic.com/33276807_MzAwLTI0MC01ZmJkNDVhNTU2.jpg",
  },
  {
    guid: "12zOVfyI0qIu77aHPKVCxXOg",
    title: "64eggs Automatic Incubator Top Enhanced",
    price: 13000,
    date_created: "Thu, 28 Jul 2022 06:58:49 GMT",
    date_moderated: "Sat, 01 Oct 2022 08:52:44 GMT",
    date_edited: "Sat, 01 Oct 2022 08:52:44 GMT",
    seller_id: 2756917,
    seller_name: "Keyval Enterprises",
    phone: "",
    category_id: 289,
    category_name: "Farm Machinery & Equipment",
    count_views: 13,
    fav_count: 0,
    adverts_count: 8536,
    feedback_count: 0,
    rating: null,
    boost_badge: "",
    capture_ts: "2022-11-07",
    image_urls: "https://pictures-kenya.jijistatic.com/38387233_MTAzMy0xMzU2LTUyNTFkY2UyMDI.webp",
  },
  {
    guid: "ifPwU8GvFJqQLJ1l4DoEGDS2",
    title: "256 Eggs Electric Automatic Incubator",
    price: 26500,
    date_created: "Tue, 21 Jun 2022 03:15:42 GMT",
    date_moderated: "Tue, 21 Jun 2022 10:58:18 GMT",
    date_edited: null,
    seller_id: 2355041,
    seller_name: "David Kimari",
    phone: "",
    category_id: 289,
    category_name: "Farm Machinery & Equipment",
    count_views: 118,
    fav_count: 2,
    adverts_count: 2729,
    feedback_count: 20,
    rating: null,
    boost_badge: "2X Diamond",
    capture_ts: "2022-11-07",
    image_urls: "https://pictures-kenya.jijistatic.com/36667634_MzAwLTQwMS02ODZlYTBkY2U2.jpg",
  },
];

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function extractImageHash(url: string): { hash: string; hashType: "modern" | "legacy" } | null {
  const modernMatch = url.match(/_([A-Za-z0-9+/\-_]+)\.(?:webp|jpg|jpeg|png)$/);
  if (modernMatch) {
    try {
      const b64 = modernMatch[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "===".slice((b64.length + 3) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf-8");
      const parts = decoded.split("-");
      if (parts.length >= 3) {
        const hash = parts[parts.length - 1];
        if (/^[a-f0-9]{6,20}$/i.test(hash)) {
          return { hash: hash.toLowerCase(), hashType: "modern" };
        }
      }
    } catch {
      // fall through
    }
  }
  const legacyMatch = url.match(/(\d+)_(.+?)_(\d+)x(\d+)\.(?:jpg|jpeg|png)$/);
  if (legacyMatch) {
    const [, id, filename] = legacyMatch;
    return { hash: `legacy:${id}:${filename}`, hashType: "legacy" };
  }
  return null;
}

async function main() {
  console.log("[seed] Loading 16 verified rows from recon CSV...");

  // Ensure market
  await db.market.upsert({
    where: { id: MARKET_ID },
    create: { id: MARKET_ID, name: "Kenya", baseUrl: MARKET_BASE, lastCensusAt: new Date() },
    update: {},
  });

  let inserted = 0;
  let updated = 0;

  for (const row of SEED_ROWS) {
    const sellerId = `${MARKET_ID}-${row.seller_id}`;
    const listingId = `${MARKET_ID}-${row.guid}`;

    // Upsert seller
    const hidePhone = false;
    const isDealer =
      (row.adverts_count ?? 0) > 0 &&
      (row.adverts_count ?? 0) / Math.max(row.feedback_count ?? 1, 1) > 50;
    await db.seller.upsert({
      where: { id: sellerId },
      create: {
        id: sellerId,
        marketId: MARKET_ID,
        numericUserId: row.seller_id,
        username: row.seller_name,
        accountAgeDays: 0,
        totalListings: row.adverts_count ?? 0,
        advertsCount: row.adverts_count ?? 0,
        feedbackCount: row.feedback_count ?? 0,
        rating: row.rating ?? 0,
        hidePhone,
        phoneLeaked: false,
        phone: row.phone || null,
        verifiedBadge: false,
        isDealer,
      },
      update: {
        advertsCount: row.adverts_count ?? undefined,
        feedbackCount: row.feedback_count ?? undefined,
        rating: row.rating ?? undefined,
        phone: row.phone || undefined,
        isDealer,
      },
    });

    // Upsert listing
    const imageUrls = row.image_urls ? row.image_urls.split(";").filter(Boolean) : [];
    const existing = await db.listing.findUnique({ where: { id: listingId } });

    if (!existing) {
      await db.listing.create({
        data: {
          id: listingId,
          marketId: MARKET_ID,
          guid: row.guid,
          title: row.title,
          price: row.price,
          currency: "KES",
          category: row.category_name,
          categoryId: row.category_id,
          condition: "unknown",
          imageUrl: imageUrls[0] ?? null,
          imageCount: imageUrls.length,
          views: row.count_views ?? 0,
          favCount: row.fav_count ?? 0,
          daysOnMarket: 0,
          url: `${MARKET_BASE}/item/${row.guid}`,
          status: "active",
          dateCreated: parseDate(row.date_created),
          dateEdited: parseDate(row.date_edited),
          dateModerated: parseDate(row.date_moderated),
          isBoost: !!row.boost_badge,
          sellerId,
          priceHistory: {
            create: [{ price: row.price, recordedAt: parseDate(row.capture_ts) ?? new Date() }],
          },
        },
      });
      inserted++;
    } else {
      updated++;
    }

    // Index image hashes
    for (const url of imageUrls) {
      const hash = extractImageHash(url);
      if (!hash) continue;
      try {
        await db.imageHash.upsert({
          where: {
            marketId_listingId_hash: {
              marketId: MARKET_ID,
              listingId,
              hash: hash.hash,
            },
          },
          create: {
            marketId: MARKET_ID,
            listingId,
            sellerId,
            hash: hash.hash,
            hashType: hash.hashType,
            url,
          },
          update: {},
        });
      } catch {
        // ignore individual failures
      }
    }
  }

  console.log(`[seed] Done. Inserted: ${inserted}, Updated: ${updated}.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[seed] FATAL:", e);
  process.exit(1);
});
