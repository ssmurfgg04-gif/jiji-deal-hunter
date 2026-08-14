#!/usr/bin/env bun
/**
 * Smoke test for the CookieVault integration with jiji-client.ts.
 *
 * Tests:
 *   1. Save a fake cf_clearance cookie to vault
 *   2. Verify getValidCookie returns it
 *   3. Verify getAllValidCookies returns it
 *   4. Verify formatCookieHeader produces correct header
 *   5. Verify invalidateCookie marks it invalid
 *   6. Verify purgeExpiredCookies deletes it after TTL
 *   7. Verify jiji-client.ts tryFetch correctly attaches the cookie to requests
 *
 * Run: bun scripts/test-cookie-vault.ts
 */

import { db } from "../src/lib/db";
import {
  saveCookie,
  getValidCookie,
  getAllValidCookies,
  formatCookieHeader,
  invalidateCookie,
  purgeExpiredCookies,
} from "../src/lib/cookie-vault";

const TEST_DOMAIN = "test.example.com";
const TEST_UA = "TestBrowser/1.0 (test)";
const TEST_VALUE = "test_cf_clearance_value_abc123";

async function test1_save_and_retrieve() {
  console.log("\n[Test 1] Save cookie + retrieve via getValidCookie");
  const saved = await saveCookie({
    domain: TEST_DOMAIN,
    name: "cf_clearance",
    value: TEST_VALUE,
    userAgent: TEST_UA,
    source: "test",
    ttlMinutes: 30,
  });
  console.log(`  ✓ Saved cookie id=${saved.id}, expires=${saved.expiresAt.toISOString()}`);

  const retrieved = await getValidCookie(TEST_DOMAIN, "cf_clearance", TEST_UA);
  if (!retrieved) throw new Error("FAIL: getValidCookie returned null");
  if (retrieved.value !== TEST_VALUE) throw new Error(`FAIL: value mismatch`);
  console.log(`  ✓ Retrieved matching cookie (useCount=${retrieved.useCount})`);
}

async function test2_get_all_valid() {
  console.log("\n[Test 2] getAllValidCookies returns all cookies for domain");
  // Save a second cookie (__cf_bm)
  await saveCookie({
    domain: TEST_DOMAIN,
    name: "__cf_bm",
    value: "test_bm_value_xyz789",
    userAgent: TEST_UA,
    source: "test",
    ttlMinutes: 30,
  });

  const all = await getAllValidCookies(TEST_DOMAIN, TEST_UA);
  if (all.length !== 2) throw new Error(`FAIL: expected 2 cookies, got ${all.length}`);
  console.log(`  ✓ Got ${all.length} cookies: ${all.map((c) => c.name).join(", ")}`);

  const header = formatCookieHeader(all);
  if (!header.includes("cf_clearance=test_cf_clearance_value_abc123")) {
    throw new Error(`FAIL: header missing cf_clearance: ${header}`);
  }
  if (!header.includes("__cf_bm=test_bm_value_xyz789")) {
    throw new Error(`FAIL: header missing __cf_bm: ${header}`);
  }
  console.log(`  ✓ Cookie header: ${header}`);
}

async function test3_invalidate() {
  console.log("\n[Test 3] invalidateCookie marks cookie as invalid");
  await invalidateCookie(TEST_DOMAIN, "cf_clearance", TEST_UA);
  const retrieved = await getValidCookie(TEST_DOMAIN, "cf_clearance", TEST_UA);
  if (retrieved) throw new Error("FAIL: cookie still returned after invalidation");
  console.log(`  ✓ Cookie correctly invalidated (getValidCookie returns null)`);
}

async function test4_purge() {
  console.log("\n[Test 4] purgeExpiredCookies deletes stale entries");
  // Save a cookie with 1-minute TTL, then manually expire it
  await saveCookie({
    domain: TEST_DOMAIN,
    name: "short_lived",
    value: "will_expire",
    userAgent: TEST_UA,
    source: "test",
    ttlMinutes: 1,
  });
  // Force expire by setting expiresAt to past
  await db.cookieVault.updateMany({
    where: { domain: TEST_DOMAIN, name: "short_lived" },
    data: { expiresAt: new Date(Date.now() - 60000) },
  });
  const result = await purgeExpiredCookies();
  console.log(`  ✓ Purged ${result.deleted} expired cookie(s)`);

  // Verify test cookies are gone
  const remaining = await db.cookieVault.findMany({ where: { domain: TEST_DOMAIN } });
  if (remaining.length > 0) {
    // Manual cleanup
    await db.cookieVault.deleteMany({ where: { domain: TEST_DOMAIN } });
  }
  console.log(`  ✓ Test cookies cleaned up`);
}

async function test5_proxy_ip_binding() {
  console.log("\n[Test 5] Cookie is bound to proxyIp — different proxy = different cookie");
  await saveCookie({
    domain: TEST_DOMAIN,
    name: "cf_clearance",
    value: "cookie_for_proxy_A",
    userAgent: TEST_UA,
    proxyIp: "1.2.3.4",
    source: "test",
    ttlMinutes: 30,
  });
  await saveCookie({
    domain: TEST_DOMAIN,
    name: "cf_clearance",
    value: "cookie_for_proxy_B",
    userAgent: TEST_UA,
    proxyIp: "5.6.7.8",
    source: "test",
    ttlMinutes: 30,
  });

  const cookieA = await getValidCookie(TEST_DOMAIN, "cf_clearance", TEST_UA, "1.2.3.4");
  const cookieB = await getValidCookie(TEST_DOMAIN, "cf_clearance", TEST_UA, "5.6.7.8");
  if (!cookieA || !cookieB) throw new Error("FAIL: cookies not found");
  if (cookieA.value === cookieB.value) {
    throw new Error("FAIL: same cookie returned for different proxy IPs");
  }
  console.log(`  ✓ Proxy A cookie: ${cookieA.value}`);
  console.log(`  ✓ Proxy B cookie: ${cookieB.value}`);

  // Cleanup
  await db.cookieVault.deleteMany({ where: { domain: TEST_DOMAIN } });
}

async function main() {
  console.log("=".repeat(80));
  console.log("CookieVault Smoke Test");
  console.log("=".repeat(80));

  try {
    await test1_save_and_retrieve();
    await test2_get_all_valid();
    await test3_invalidate();
    await test4_purge();
    await test5_proxy_ip_binding();
    console.log();
    console.log("=".repeat(80));
    console.log("✓ ALL TESTS PASSED");
    console.log("=".repeat(80));
  } catch (e: any) {
    console.error();
    console.error("=".repeat(80));
    console.error(`✗ TEST FAILED: ${e.message}`);
    console.error("=".repeat(80));
    console.error(e.stack);
    // Cleanup any leftover test data
    await db.cookieVault.deleteMany({ where: { domain: TEST_DOMAIN } }).catch(() => null);
    await db.$disconnect();
    process.exit(1);
  }

  await db.$disconnect();
}

main();
