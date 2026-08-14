#!/usr/bin/env bun
/**
 * Purge all synthetic training data from the DB.
 * Keeps the 16 real archived listings (guid does not start with "synth-").
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("[purge] Counting synthetic listings...");
  const synthListings = await db.listing.findMany({
    where: { guid: { startsWith: "synth-" } },
    select: { id: true },
  });
  console.log(`[purge] Found ${synthListings.length} synthetic listings to delete`);

  // Delete in dependency order: imageHashes, priceHistory, dealScores, listings, then synth sellers
  for (const l of synthListings) {
    await db.imageHash.deleteMany({ where: { listingId: l.id } }).catch(() => {});
    await db.priceHistory.deleteMany({ where: { listingId: l.id } }).catch(() => {});
    await db.dealScore.deleteMany({ where: { listingId: l.id } }).catch(() => {});
  }
  const deletedListings = await db.listing.deleteMany({
    where: { guid: { startsWith: "synth-" } },
  });
  console.log(`[purge] Deleted ${deletedListings.count} synthetic listings`);

  // Delete synth sellers
  const deletedSellers = await db.seller.deleteMany({
    where: { id: { contains: "synth-" } },
  });
  console.log(`[purge] Deleted ${deletedSellers.count} synthetic sellers`);

  // Report what remains
  const remainingListings = await db.listing.count();
  const remainingSellers = await db.seller.count();
  const remainingHashes = await db.imageHash.count();
  console.log(`[purge] Remaining: ${remainingListings} listings, ${remainingSellers} sellers, ${remainingHashes} image hashes`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[purge] FATAL:", e);
  process.exit(1);
});
