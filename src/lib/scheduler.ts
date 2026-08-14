/**
 * Auto-Collection Scheduler — DB-backed state (serverless-safe).
 *
 * Previously this module kept state in module-level mutable objects. That
 * broke under serverless / multi-instance deployments: each instance had its
 * own copy of `state`, so the dashboard saw scheduler state from whichever
 * instance happened to serve the request, and `triggerImmediate()` could fire
 * on every replica simultaneously.
 *
 * Now all state lives in the `ServerState` singleton row. Reads go through
 * `getSchedulerStatus()` (which hits the DB), writes go through
 * `updateSchedulerState()` (atomic upsert).
 *
 * The timer itself still runs in-process — there's no way around that without
 * an external cron. To prevent multi-instance double-fire, the tick function
 * does an atomic `schedulerRunning = true` swap before doing work (CAS via
 * Prisma's updateMany with `where: { schedulerRunning: false }`). If another
 * instance already flipped it, this instance skips.
 *
 * Configurable via env:
 *   JIJI_AUTOCOLLECT_INTERVAL_MS  (default 1800000 = 30 min)
 *   JIJI_AUTOCOLLECT_ENABLED      (default "true")
 *   JIJI_AUTOCOLLECT_LOCK_TTL_MS  (default 1800000 = 30 min)
 *      — if `schedulerRunning` has been true for longer than this, the lock
 *      is considered stale (crashed process) and reset by the next tick.
 */

import { runCollection } from "./collector";
import { db } from "./db";

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastRunSummary: {
    itemsCollected: number;
    itemsUpdated: number;
    fakeDiscounts: number;
    scamsFlagged: number;
    durationMs: number;
  } | null;
  nextRunAt: string | null;
  totalRuns: number;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — stale lock reset threshold
const SINGLETON_ID = "singleton";

// In-process timer. Only the instance that owns this timer actually ticks.
let timer: NodeJS.Timeout | null = null;
let starting = false;

/**
 * Ensure the singleton ServerState row exists, then return it.
 */
async function loadState() {
  // create-if-missing
  const existing = await db.serverState.findUnique({ where: { id: SINGLETON_ID } });
  if (existing) return existing;

  const intervalMs =
    parseInt(process.env.JIJI_AUTOCOLLECT_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS;
  const enabled = process.env.JIJI_AUTOCOLLECT_ENABLED !== "false";

  return db.serverState.create({
    data: {
      id: SINGLETON_ID,
      schedulerEnabled: enabled,
      schedulerIntervalMs: intervalMs,
    },
  });
}

/**
 * Atomic compare-and-swap: only sets schedulerRunning=true if it was false
 * (or stale). Returns true if this instance won the lock.
 */
async function acquireRunLock(): Promise<boolean> {
  const lockTtlMs =
    parseInt(process.env.JIJI_AUTOCOLLECT_LOCK_TTL_MS ?? "", 10) || DEFAULT_LOCK_TTL_MS;
  const staleBefore = new Date(Date.now() - lockTtlMs);

  // CAS: update only if running=false OR lastRunAt is older than TTL (stale).
  // We use updatedAt as a proxy for "lock acquired at" — when we set
  // schedulerRunning=true, updatedAt also bumps to now, so a stale lock
  // is detected as `updatedAt < staleBefore`.
  const result = await db.serverState.updateMany({
    where: {
      id: SINGLETON_ID,
      OR: [
        { schedulerRunning: false },
        { updatedAt: { lt: staleBefore } },
      ],
    },
    data: { schedulerRunning: true },
  });
  return result.count > 0;
}

async function releaseRunLock(summary: SchedulerStatus["lastRunSummary"]) {
  const state = await loadState();
  const now = new Date();
  await db.serverState.update({
    where: { id: SINGLETON_ID },
    data: {
      schedulerRunning: false,
      schedulerLastRunAt: now,
      schedulerNextRunAt: new Date(now.getTime() + state.schedulerIntervalMs),
      schedulerTotalRuns: { increment: 1 },
      schedulerLastSummary: JSON.stringify(summary ?? {}),
    },
  });
}

/**
 * One collection tick. Guards against overlap (if a previous run is still
 * in flight, skip this tick). Uses atomic DB CAS so multiple instances
 * don't double-fire.
 */
async function tick() {
  const state = await loadState();
  if (!state.schedulerEnabled) return;

  // Atomic lock — returns false if another instance is already running.
  const gotLock = await acquireRunLock();
  if (!gotLock) return;

  const startedAt = Date.now();
  try {
    const summary = await runCollection({});
    await releaseRunLock({
      itemsCollected: summary.itemsCollected,
      itemsUpdated: summary.itemsUpdated,
      fakeDiscounts: summary.fakeDiscounts,
      scamsFlagged: summary.scamsFlagged,
      durationMs: summary.durationMs,
    });
  } catch (e) {
    // Swallow — we don't want a failed collection to crash the scheduler loop.
    await releaseRunLock(null);
  }
}

/**
 * Start the scheduler. Safe to call multiple times — guards against
 * double-init via the `starting` flag (set synchronously).
 */
export function startScheduler(): void {
  if (timer || starting) return;
  starting = true;

  const firstRunDelayMs = 5000;
  setTimeout(() => {
    starting = false;
    void tick();
    void loadState().then((s) => {
      timer = setInterval(tick, s.schedulerIntervalMs);
    });
  }, firstRunDelayMs);
}

/**
 * Pause / resume the scheduler (DB-backed — affects all instances).
 */
export async function setSchedulerEnabled(enabled: boolean): Promise<void> {
  await db.serverState.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, schedulerEnabled: enabled },
    update: {
      schedulerEnabled: enabled,
      // If pausing, clear next-run and stop in-process timer.
      ...(enabled ? {} : { schedulerNextRunAt: null }),
    },
  });

  if (!enabled && timer) {
    clearInterval(timer);
    timer = null;
  } else if (enabled && !timer) {
    startScheduler();
  }
}

/**
 * Trigger an immediate collection (used by /api/scheduler trigger endpoint).
 * Atomic lock prevents multiple instances from double-firing.
 */
export async function triggerImmediate(): Promise<void> {
  await tick();
}

/**
 * Snapshot of current scheduler state (DB-backed — for the dashboard).
 */
export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const state = await loadState();
  let lastRunSummary: SchedulerStatus["lastRunSummary"] = null;
  try {
    const parsed = JSON.parse(state.schedulerLastSummary || "{}");
    if (parsed && typeof parsed === "object" && "itemsCollected" in parsed) {
      lastRunSummary = parsed;
    }
  } catch {
    // corrupt JSON — treat as null
  }

  return {
    enabled: state.schedulerEnabled,
    running: state.schedulerRunning,
    intervalMs: state.schedulerIntervalMs,
    lastRunAt: state.schedulerLastRunAt?.toISOString() ?? null,
    lastRunSummary,
    nextRunAt: state.schedulerNextRunAt?.toISOString() ?? null,
    totalRuns: state.schedulerTotalRuns,
  };
}
