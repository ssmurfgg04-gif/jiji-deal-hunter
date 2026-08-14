#!/usr/bin/env bun
/**
 * Save a cf_clearance cookie to the CookieVault.
 *
 * Use this when you've manually solved a Cloudflare challenge (e.g. via a
 * real browser + copy-cookie extension) and want the collector to reuse it.
 *
 * Usage:
 *   bun scripts/save-cookie.ts \
 *     --domain=jiji.co.ke \
 *     --name=cf_clearance \
 *     --value="abc123..." \
 *     --ua="Mozilla/5.0 ..." \
 *     --source=manual \
 *     --ttl=30
 *
 * Or read from a JSON file:
 *   bun scripts/save-cookie.ts --file=cookies.json
 *
 * JSON file format:
 *   [{
 *     "domain": "jiji.co.ke",
 *     "name": "cf_clearance",
 *     "value": "abc123...",
 *     "userAgent": "Mozilla/5.0 ...",
 *     "source": "manual",
 *     "ttlMinutes": 30
 *   }, ...]
 */

import { db } from "../src/lib/db";
import { saveCookie, purgeExpiredCookies, getAllValidCookies, formatCookieHeader } from "../src/lib/cookie-vault";

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = v ?? "true";
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();

  if (args.help || Object.keys(args).length === 0) {
    console.log(`Usage:
  bun scripts/save-cookie.ts --domain=jiji.co.ke --name=cf_clearance --value=ABC --ua="Mozilla/5.0" [--source=manual] [--ttl=30] [--proxy-ip=1.2.3.4]
  bun scripts/save-cookie.ts --file=cookies.json
  bun scripts/save-cookie.ts --list                # show all valid cookies
  bun scripts/save-cookie.ts --purge               # delete expired cookies
`);
    process.exit(0);
  }

  // List mode
  if (args.list !== undefined) {
    console.log("Valid cookies in vault:");
    const domains = await db.cookieVault.findMany({
      where: { isValid: true, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" },
    });
    if (domains.length === 0) {
      console.log("  (none)");
    } else {
      for (const c of domains) {
        const remaining = Math.round((c.expiresAt.getTime() - Date.now()) / 60000);
        console.log(`  [${c.id}] ${c.domain} / ${c.name} / UA=${c.userAgent.slice(0, 50)}...`);
        console.log(`      proxyIp=${c.proxyIp ?? "direct"} source=${c.source} TTL=${remaining}min uses=${c.useCount}`);
      }
    }
    await db.$disconnect();
    return;
  }

  // Purge mode
  if (args.purge !== undefined) {
    const result = await purgeExpiredCookies();
    console.log(`Deleted ${result.deleted} expired/invalid cookies.`);
    await db.$disconnect();
    return;
  }

  // File mode
  if (args.file) {
    const fs = await import("fs");
    const raw = fs.readFileSync(args.file, "utf-8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) {
      console.error("File must contain a JSON array of cookie objects");
      process.exit(1);
    }
    let saved = 0;
    for (const c of cookies) {
      try {
        await saveCookie({
          domain: c.domain,
          name: c.name,
          value: c.value,
          userAgent: c.userAgent ?? c.ua ?? "Mozilla/5.0",
          proxyIp: c.proxyIp ?? null,
          source: c.source ?? "manual",
          ttlMinutes: c.ttlMinutes ?? c.ttl ?? 30,
        });
        saved++;
        console.log(`  ✓ Saved ${c.domain}/${c.name}`);
      } catch (e: any) {
        console.error(`  ✗ Failed ${c.domain}/${c.name}: ${e.message}`);
      }
    }
    console.log(`\nSaved ${saved}/${cookies.length} cookies.`);
    await db.$disconnect();
    return;
  }

  // Single-cookie mode
  if (!args.domain || !args.name || !args.value || !args.ua) {
    console.error("Missing required args: --domain, --name, --value, --ua");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  const cookie = await saveCookie({
    domain: args.domain,
    name: args.name,
    value: args.value,
    userAgent: args.ua,
    proxyIp: args["proxy-ip"] ?? null,
    source: args.source ?? "manual",
    ttlMinutes: args.ttl ? parseInt(args.ttl, 10) : 30,
  });

  console.log(`✓ Saved cookie:`);
  console.log(`  Domain:   ${cookie.domain}`);
  console.log(`  Name:     ${cookie.name}`);
  console.log(`  Value:    ${cookie.value.slice(0, 30)}...`);
  console.log(`  UA:       ${cookie.userAgent}`);
  console.log(`  ProxyIP:  ${cookie.proxyIp ?? "direct"}`);
  console.log(`  Source:   ${cookie.source}`);
  console.log(`  Expires:  ${cookie.expiresAt.toISOString()} (TTL ${args.ttl ?? 30} min)`);

  // Verify by listing valid cookies
  const valid = await getAllValidCookies(cookie.domain, cookie.userAgent, cookie.proxyIp ?? null);
  console.log(`\nValid cookies for ${cookie.domain}: ${valid.length}`);
  if (valid.length > 0) {
    console.log(`  Cookie header: ${formatCookieHeader(valid).slice(0, 100)}...`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
