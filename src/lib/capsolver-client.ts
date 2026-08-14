/**
 * CapSolver Client — Tier 3 Cloudflare Turnstile bypass (paid API).
 *
 * CapSolver solves Cloudflare Turnstile challenges via API. We send them the
 * sitekey + URL, they return a token + cookies.
 *
 * Pricing: ~$1-3 per 1000 solves. Promo code "CURL" = +6% balance.
 * Sign up: https://www.capsolver.com/products/cloudflare
 *
 * Two modes:
 *   1. AntiCloudflareTask (with your proxy) — returns cookies bound to your IP
 *   2. AntiCloudflareTaskProxyLess — returns cookies bound to their IP
 *      (cookies won't work from your IP — must route requests via their proxy)
 *
 * We use ProxyLess mode as Tier 3 fallback. The returned token can be
 * submitted to jiji.co.ke's challenge endpoint to obtain cf_clearance bound
 * to OUR IP (requires a follow-up request from our server with the token).
 *
 * Per docs/CLOUDFLARE_BYPASS_RESEARCH.md section "Tier 3".
 */

const CAPSOLVER_API_URL = "https://api.capsolver.com";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY;
const CAPSOLVER_MAX_WAIT_MS = parseInt(
  process.env.CAPSOLVER_MAX_WAIT_MS ?? "120000",
  10
);

// Known Jiji Turnstile sitekey (from agent-browser recon)
const JIJI_TURNSTILE_SITEKEY = "0x4AAAAAAADnPIDROrmt1Wwj";

export interface CapSolverCookie {
  name: string;
  value: string;
  domain?: string;
}

export interface CapSolverResult {
  ok: boolean;
  token?: string;
  userAgent?: string;
  cookies?: CapSolverCookie[];
  taskId?: string;
  cost?: number;
  error?: string;
}

export function isCapSolverConfigured(): boolean {
  return Boolean(CAPSOLVER_API_KEY);
}

/**
 * Solve a Cloudflare Turnstile challenge via CapSolver.
 *
 * @param url Page URL where Turnstile is rendered
 * @param sitekey Turnstile sitekey (defaults to Jiji's known key)
 * @returns Token + cookies (when ProxyLess mode succeeds)
 */
export async function solveTurnstileViaCapSolver(
  url: string,
  sitekey: string = JIJI_TURNSTILE_SITEKEY
): Promise<CapSolverResult> {
  if (!CAPSOLVER_API_KEY) {
    return { ok: false, error: "CAPSOLVER_API_KEY not set" };
  }

  try {
    // Step 1: Create task
    const createResp = await fetch(`${CAPSOLVER_API_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: "AntiCloudflareTaskProxyLess",
          websiteURL: url,
          websiteKey: sitekey,
          metadata: { action: "managed", cdata: "" },
        },
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text().catch(() => "");
      return {
        ok: false,
        error: `CapSolver create HTTP ${createResp.status}: ${text.slice(0, 200)}`,
      };
    }

    const createJson: any = await createResp.json();
    if (createJson.errorId !== 0) {
      return {
        ok: false,
        error: createJson.errorDescription ?? "CapSolver task creation failed",
      };
    }

    const taskId = createJson.taskId;
    if (!taskId) {
      return { ok: false, error: "CapSolver returned no taskId" };
    }

    console.log(`[capsolver] Task ${taskId} created for ${url} — polling...`);

    // Step 2: Poll for result (3s intervals, up to CAPSOLVER_MAX_WAIT_MS)
    const startTime = Date.now();
    while (Date.now() - startTime < CAPSOLVER_MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 3000));

      const pollResp = await fetch(`${CAPSOLVER_API_URL}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: CAPSOLVER_API_KEY,
          taskId,
        }),
      });

      if (!pollResp.ok) continue;

      const pollJson: any = await pollResp.json();
      if (pollJson.errorId !== 0) {
        return {
          ok: false,
          error: pollJson.errorDescription ?? "CapSolver task failed",
          taskId,
        };
      }

      if (pollJson.status === "ready") {
        const solution = pollJson.solution ?? {};
        console.log(
          `[capsolver] Task ${taskId} solved — token=${(solution.token ?? "").slice(0, 30)}...`
        );
        return {
          ok: true,
          token: solution.token ?? solution.responseText,
          userAgent: solution.userAgent,
          cookies: solution.cookies,
          taskId,
          cost: pollJson.cost,
        };
      }
      // status === "processing" — keep polling
    }

    return { ok: false, error: "CapSolver timeout", taskId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network error" };
  }
}

/**
 * Convenience: solve Turnstile + save cookies to CookieVault.
 * Returns true if cookies were saved successfully.
 */
export async function solveAndSaveCookies(
  url: string,
  sitekey: string = JIJI_TURNSTILE_SITEKEY
): Promise<boolean> {
  const result = await solveTurnstileViaCapSolver(url, sitekey);
  if (!result.ok) {
    console.warn(`[capsolver] Failed: ${result.error}`);
    return false;
  }
  if (!result.cookies || result.cookies.length === 0) {
    console.warn(`[capsolver] No cookies returned — token only mode`);
    return false;
  }

  // Save cookies to CookieVault
  try {
    const { saveCookie } = await import("./cookie-vault");
    const targetDomain = new URL(url).hostname;
    const userAgent = result.userAgent ?? "";
    if (!userAgent) {
      console.warn(`[capsolver] No userAgent returned — cookies may not bind correctly`);
    }

    let saved = 0;
    for (const cookie of result.cookies) {
      if (cookie.name === "cf_clearance" || cookie.name === "__cf_bm") {
        await saveCookie({
          domain: targetDomain,
          name: cookie.name,
          value: cookie.value,
          userAgent,
          proxyIp: null, // ProxyLess mode — cookies bound to CapSolver's IP
          source: "capsolver",
          ttlMinutes: 30,
        });
        saved++;
      }
    }
    console.log(`[capsolver] Saved ${saved} cookies to vault`);
    return saved > 0;
  } catch (e: any) {
    console.warn(`[capsolver] Failed to save cookies:`, e?.message);
    return false;
  }
}
