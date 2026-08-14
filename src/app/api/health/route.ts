/**
 * Health Check Endpoint — used by Docker/K8s liveness & readiness probes.
 *
 * Returns 200 if the app can:
 *   1. Reach the DB (Prisma can execute a trivial query)
 *   2. Load the deal-scorer model (optional — falls back to hand-tuned)
 *
 * Returns 503 if any critical check fails, with a structured error body
 * so the orchestrator can decide whether to restart the container.
 *
 * Designed for <50ms response time — no heavy work here. For deeper checks
 * (live Jiji API reachability, proxy pool health) use /api/status instead.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HealthCheck {
  ok: boolean;
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    db: { ok: boolean; latencyMs: number; error?: string };
    scorerModelLoaded?: { ok: boolean; version?: number; trees?: number };
  };
  version: string;
  timestamp: string;
  uptimeMs: number;
}

const START_TIME = Date.now();
const APP_VERSION = process.env.APP_VERSION ?? "0.2.1";

export async function GET() {
  const checks: HealthCheck["checks"] = {
    db: { ok: false, latencyMs: 0 },
  };

  // 1. DB reachability — execute a trivial SELECT 1
  const dbStart = Date.now();
  try {
    await db.$queryRawUnsafe("SELECT 1");
    checks.db.ok = true;
    checks.db.latencyMs = Date.now() - dbStart;
  } catch (e: any) {
    checks.db.ok = false;
    checks.db.latencyMs = Date.now() - dbStart;
    checks.db.error = e?.message ?? "unknown DB error";
  }

  // 2. Scorer model — non-blocking, non-fatal if missing
  // (deal-scorer falls back to hand-tuned weights if v3 JSON absent)
  try {
    const { existsSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const modelPath = join(process.cwd(), "ml-models", "deal_scorer_v3.json");
    if (existsSync(modelPath)) {
      const raw = readFileSync(modelPath, "utf-8");
      const parsed = JSON.parse(raw);
      checks.scorerModelLoaded = {
        ok: true,
        version: parsed.version,
        trees: parsed.trees?.length,
      };
    } else {
      checks.scorerModelLoaded = { ok: false };
    }
  } catch {
    checks.scorerModelLoaded = { ok: false };
  }

  const dbOk = checks.db.ok;
  const scorerOk = !checks.scorerModelLoaded || checks.scorerModelLoaded.ok;

  const status: HealthCheck["status"] = dbOk ? (scorerOk ? "healthy" : "degraded") : "unhealthy";
  const httpStatus = status === "unhealthy" ? 503 : 200;

  const body: HealthCheck = {
    ok: status !== "unhealthy",
    status,
    checks,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - START_TIME,
  };

  return NextResponse.json(body, { status: httpStatus });
}
