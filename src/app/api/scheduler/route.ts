import { NextResponse } from "next/server";
import {
  getSchedulerStatus,
  setSchedulerEnabled,
  triggerImmediate,
} from "@/lib/scheduler";

/**
 * GET /api/scheduler — current scheduler status (next run, interval, last summary)
 */
export async function GET() {
  return NextResponse.json(await getSchedulerStatus());
}

/**
 * POST /api/scheduler
 * Body: { action: "pause" | "resume" | "trigger" }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === "pause") {
    await setSchedulerEnabled(false);
    return NextResponse.json({ ok: true, status: await getSchedulerStatus() });
  }
  if (action === "resume") {
    await setSchedulerEnabled(true);
    return NextResponse.json({ ok: true, status: await getSchedulerStatus() });
  }
  if (action === "trigger") {
    await triggerImmediate();
    return NextResponse.json({ ok: true, status: await getSchedulerStatus() });
  }
  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
