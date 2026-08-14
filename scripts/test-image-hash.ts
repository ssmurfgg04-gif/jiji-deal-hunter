// Quick verification of extractImageHash against recon examples
import { Buffer } from "buffer";

// Inline the extractor so we don't need to compile the TS module
function extractImageHash(url: string): { hash: string; hashType: "modern" | "legacy" } | null {
  if (!url || typeof url !== "string") return null;

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

  const idMatch = url.match(/(\d{6,})_/);
  if (idMatch) {
    return { hash: `id:${idMatch[1]}`, hashType: "modern" };
  }

  return null;
}

const testUrls = [
  "https://pictures-kenya.jijistatic.com/42634303_MTEyNS0xNTAwLWZjOGE5ZjJhZTE.webp",
  "https://pictures-kenya.jijistatic.com/42634303_MjAwLTIwMC02ZmE1NzVkZmI1.webp",
  "https://ke1.jijistatic.com/42634303_photo_800x600.jpg",
  "https://pictures-nigeria.jijistatic.com/99999999_random.webp",
  "https://pictures-kenya.jijistatic.com/12345678_ODEwMC02MDAtYWJjZGVmMTIzNDU.webp",
];

for (const url of testUrls) {
  const result = extractImageHash(url);
  console.log(`URL: ${url}`);
  console.log(`  → ${result ? JSON.stringify(result) : "null"}`);
}

const reconB64 = "MTEyNS0xNTAwLWZjOGE5ZjJhZTE";
const decoded = Buffer.from(reconB64 + "===".slice((reconB64.length + 3) % 4), "base64").toString("utf-8");
console.log(`\nRecon verification: ${reconB64} → "${decoded}"`);
console.log(`Expected hash: fc8a9f2ae1`);
