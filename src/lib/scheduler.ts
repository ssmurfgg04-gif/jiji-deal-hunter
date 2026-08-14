/**
 * Auto-Collection Scheduler
 *
 * Runs a server-side setInterval that triggers `runCollection` on a fixed
 * interval (default: every 30 minutes). Started once on server boot via
 * instrumentation.ts.
 *
 * The scheduler state is kept in-memory and exposed via /api/scheduler so
 * the dashboard can show "next collection in X minutes" and pause/resume.
 *
 * Configurable via env:
 *   JIJI_AUTOCOLLECT_INTERVAL_MS  (default 1800000 = 30 min)
 *   JIJI_AUTOCOLLECT_ENABLED      (default "true")
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

const state = {
  enabled: process.env.JIJI_AUTOCOLLECT_ENABLED !== "false",
  running: false,
  starting: false, // synchronously set to prevent double-start race
  intervalMs: parseInt(process.env.JIJI_AUTOCOLLECT_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS,
  lastRunAt: null as string | null,
  lastRunSummary: null as SchedulerStatus["lastRunSummary"],
  nextRunAt: null as string | null,
  totalRuns: 0,
  timer: null as NodeJS.Timeout | null,
};

/**
 * One collection tick. Guards against overlap (if a previous run is still
 * in flight, skip this tick).
 */
async function tick() {
  if (!state.enabled || state.running) return;
  state.running = true;
  const startedAt = Date.now();
  try {
    const summary = await runCollection({ sourceMode: "api" });
    state.lastRunAt = new Date(startedAt).toISOString();
    state.lastRunSummary = {
      itemsCollected: summary.itemsCollected,
      itemsUpdated: summary.itemsUpdated,
      fakeDiscounts: summary.fakeDiscounts,
      scamsFlagged: summary.scamsFlagged,
      durationMs: summary.durationMs,
    };
    state.totalRuns++;
    state.nextRunAt = new Date(startedAt + state.intervalMs).toISOString();
  } catch (e) {
    // Swallow — we don't want a failed collection to crash the scheduler loop.
    state.lastRunAt = new Date(startedAt).toISOString();
    state.nextRunAt = new Date(startedAt + state.intervalMs).toISOString();
  } finally {
    state.running = false;
  }
}

/**
 * Start the scheduler. Safe to call multiple times — guards against
 * double-init via the `state.starting` flag (set synchronously).
 */
export function startScheduler(): void {
  if (state.timer || state.starting) return;
  if (!state.enabled) {
    state.nextRunAt = null;
    return;
  }
  state.starting = true;
  const firstRunDelayMs = 5000;
  setTimeout(() => {
    state.starting = false;
    tick();
    state.timer = setInterval(tick, state.intervalMs);
    state.nextRunAt = new Date(Date.now() + state.intervalMs).toISOString();
  }, firstRunDelayMs);
}

/**
 * Pause / resume the scheduler.
 */
export function setSchedulerEnabled(enabled: boolean): void {
  state.enabled = enabled;
  if (!enabled && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    state.nextRunAt = null;
  } else if (enabled && !state.timer) {
    startScheduler();
  }
}

/**
 * Trigger an immediate collection (used by /api/scheduler trigger endpoint).
 */
export async function triggerImmediate(): Promise<void> {
  await tick();
}

/**
 * Snapshot of current scheduler state (for the dashboard).
 */
export function getSchedulerStatus(): SchedulerStatus {
  return {
    enabled: state.enabled,
    running: state.running,
    intervalMs: state.intervalMs,
    lastRunAt: state.lastRunAt,
    lastRunSummary: state.lastRunSummary,
    nextRunAt: state.nextRunAt,
    totalRuns: state.totalRuns,
  };
}
