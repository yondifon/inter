import type { StateStore } from "./store";
import type { ProfileStatus } from "./profile-status";
import type { TaskHold } from "./types";

/**
 * The hold sweep: one 30-second interval that evaluates due holds and releases
 * the ones whose conditions are true. Level-driven on purpose — a timer is
 * process state and a hold is persisted state, so after a restart the database
 * is the only truth. The first pass runs immediately, which is also the
 * catch-up for holds that came due while the broker was down.
 *
 * A rate-limit hold releases on the account's *status*, not on the clock alone:
 * `startAt` and `nextCheckAt` are poll hints, and the release rule is the
 * profile+model no longer reporting `unavailable`. A status can only turn
 * `unknown` after its retry time passes — nothing but a real generation proves
 * availability — so the release itself is the probe.
 */

export interface HoldSweepDependencies {
  listStatuses(query: { profile: string; model?: string; cwd?: string }): Promise<ProfileStatus[]>;
  /** Replays the stored resume for a released hold. */
  release(taskId: string, instruction?: string): Promise<unknown>;
  now(): Date;
  log(line: string): void;
}

const SWEEP_INTERVAL_MS = 30_000;
const MIN_RECHECK_MS = 30_000;
const MAX_RECHECK_MS = 3_600_000;
export const HOLD_EXPIRY_MS = 7 * 24 * 3_600_000;

export function startHoldSweep(store: () => StateStore, deps: HoldSweepDependencies): () => void {
  // One pass at a time: a pass slower than the interval (a hung status probe)
  // must not be overlapped by the next tick and race itself over one hold.
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    Promise.resolve().then(() => sweepHolds(store(), deps)).catch((error) => {
      deps.log(`hold sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { running = false; });
  };
  pass();
  const timer = setInterval(pass, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function sweepHolds(store: StateStore, deps: HoldSweepDependencies): Promise<void> {
  const now = deps.now();
  for (const hold of store.dueTaskHolds(now.toISOString())) {
    try {
      await evaluateHold(store, deps, hold, now);
    } catch (error) {
      deps.log(
        `hold on task ${hold.taskId} failed to evaluate: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      store.touchTaskHold(hold.taskId, new Date(now.getTime() + MAX_RECHECK_MS).toISOString());
    }
  }
}

async function evaluateHold(
  store: StateStore,
  deps: HoldSweepDependencies,
  hold: TaskHold,
  now: Date,
): Promise<void> {
  const task = store.getTask(hold.taskId);
  if (!task || task.state !== "pending") {
    store.dropTaskHold(hold.taskId, "hold_dropped", {
      reason: task ? `task is ${task.state}, no longer waiting` : "task no longer exists",
    });
    return;
  }
  if (now.toISOString() >= hold.expiresAt) {
    store.blockHeldTask(
      hold.taskId,
      `held until ${hold.expiresAt} without its start condition coming true; ${hold.note}`,
    );
    store.dropTaskHold(hold.taskId, "hold_expired", { dueAt: hold.startAt ?? hold.nextCheckAt });
    return;
  }
  if (hold.startAt && now.toISOString() < hold.startAt) {
    store.touchTaskHold(hold.taskId, hold.startAt);
    return;
  }
  if (hold.awaitProfile) {
    const statuses = await deps.listStatuses({
      profile: hold.awaitProfile,
      ...(hold.awaitModel ? { model: hold.awaitModel } : {}),
      cwd: task.cwd,
    });
    const down = statuses.find((status) => status.state === "unavailable");
    if (down) {
      store.touchTaskHold(hold.taskId, nextCheck(now, down.retryAt), hold.probeCount + 1);
      return;
    }
  }
  const lateMs = hold.startAt ? now.getTime() - Date.parse(hold.startAt) : 0;
  // The delete is the atomic claim on this hold; a pass that lost the race
  // must not release a second time.
  const claimed = store.dropTaskHold(hold.taskId, lateMs > 10 * 60_000 ? "hold_released_late" : "hold_released", {
    note: hold.note,
    probeCount: hold.probeCount,
    ...(lateMs > 10 * 60_000 ? { lateMinutes: Math.round(lateMs / 60_000) } : {}),
  });
  if (!claimed) return;
  try {
    await deps.release(hold.taskId, hold.args.instruction);
  } catch (error) {
    // The hold is already gone, so a failed release must surface the task
    // instead of leaving it silently pending with nothing watching it.
    store.blockHeldTask(
      hold.taskId,
      `the hold released but the resume failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The unmet condition's own hint, floored and capped so a hold stays live. */
function nextCheck(now: Date, retryAt?: string): string {
  const hinted = retryAt ? Date.parse(retryAt) - now.getTime() : MIN_RECHECK_MS;
  const wait = Math.min(Math.max(hinted, MIN_RECHECK_MS), MAX_RECHECK_MS);
  return new Date(now.getTime() + wait).toISOString();
}

/**
 * Resolves a caller's `startAt` into the hold's clock fields. Accepts the
 * literal `rate_limit` (resolved by the caller from the failed run), an ISO
 * instant, or a duration like `45m` / `4h`.
 */
export function resolveStartAt(startAt: string, now: Date): string {
  const duration = /^(\d+)(m|h)$/.exec(startAt.trim());
  if (duration) {
    const ms = Number(duration[1]) * (duration[2] === "h" ? 3_600_000 : 60_000);
    return new Date(now.getTime() + ms).toISOString();
  }
  const instant = Date.parse(startAt);
  if (Number.isNaN(instant)) {
    throw new Error(
      `startAt must be "rate_limit", an ISO timestamp, or a duration like "45m" or "4h", got: ${startAt}`,
    );
  }
  return new Date(instant).toISOString();
}
