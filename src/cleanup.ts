import { StateStore } from "./store";
import type { CleanupPlan, CleanupRecord, CleanupResult } from "./store";
import { CliRefusal } from "./cli-error";

/**
 * `inter cleanup` is the one path that permanently removes data, and the only
 * one in the product that cannot be undone. Everything else that looks
 * destructive is not: archive hides a task and restores it, cancel stops a run
 * and keeps the record, resume picks the same provider session back up.
 *
 * So the command is built around the preview. Running it reports what would go
 * and removes nothing; `--delete` is a second, typed decision. There is no MCP
 * tool for it on purpose — an agent can archive work, which is reversible, but
 * the irreversible half stays with the person at the terminal.
 */

/** Preview-only fallback. Deleting never uses it; it must be typed. */
const DEFAULT_PREVIEW_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 3_650;
const DAY_MS = 86_400_000;

/** Late enough that it never competes with broker startup, then once a day. */
const FIRST_PASS_DELAY_MS = 5 * 60_000;
const PASS_INTERVAL_MS = 24 * 3_600_000;

export interface CleanupArgs {
  olderThanDays: number;
  /** False for a preview. Deleting is always a separate, explicit flag. */
  execute: boolean;
  /** False when the retention fell back to the preview default. */
  chosenDays: boolean;
}

export function cleanupUsage(): string {
  return `usage: inter cleanup [--older-than <days>] [--delete]

  Reports what would be permanently deleted and deletes nothing. Add --delete
  to actually remove it.

  --older-than <days>  How long finished work keeps its activity. 30 or 30d.
                       Defaults to ${DEFAULT_PREVIEW_DAYS} days for a preview; --delete requires it.
  --delete             Delete, permanently. There is nothing to restore from.

  Only tasks that have finished and that you archived are ever eligible.
  Work that is running or waiting on you, work you have not archived, and
  project memories are never deleted.`;
}

export function parseCleanupArgs(argv: readonly string[]): CleanupArgs | { error: string } {
  let olderThanDays = DEFAULT_PREVIEW_DAYS;
  let chosenDays = false;
  let execute = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--delete") {
      execute = true;
      continue;
    }
    const inline = arg.startsWith("--older-than=") ? arg.slice("--older-than=".length) : undefined;
    if (inline !== undefined || arg === "--older-than") {
      const value = inline ?? argv[index += 1];
      if (value === undefined) return { error: "--older-than needs a value" };
      const days = parseDays(value);
      if (days === undefined) {
        return { error: `--older-than must be a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}: ${value}` };
      }
      olderThanDays = days;
      chosenDays = true;
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }

  // The default retention is fine for looking. Choosing what to destroy is not
  // a decision this command gets to make on the maintainer's behalf.
  if (execute && !chosenDays) {
    return { error: "--delete needs --older-than <days>, so the retention is one you chose" };
  }
  return { olderThanDays, execute, chosenDays };
}

function parseDays(value: string): number | undefined {
  const match = /^(\d+)d?$/.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1]);
  return days >= MIN_DAYS && days <= MAX_DAYS ? days : undefined;
}

export function cutoffFor(days: number, now = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/**
 * The safety line, restated wherever a person is about to act on these numbers.
 * It is the answer to the question the preview raises and the report should not
 * leave open: what survives.
 */
const KEPT =
  "Each of those tasks keeps its title, prompt, result, cost and lineage, and\n" +
  "still lists and opens as before. Only the step-by-step activity of the runs\n" +
  "goes. Project memories are never touched.";

export function previewReport(
  plan: CleanupPlan,
  args: Pick<CleanupArgs, "olderThanDays" | "chosenDays">,
  last?: CleanupRecord,
): string {
  const age = `${args.olderThanDays} day${args.olderThanDays === 1 ? "" : "s"}`;
  const nothing = nothingToDelete(plan, age);
  const lines = [
    nothing
      ? "Nothing has been deleted, and nothing would be."
      : `Nothing has been deleted. This is what would go at ${age}${args.chosenDays ? "" : ", the default"}.`,
    "",
  ];

  lines.push(...(nothing ? [nothing] : [
    `Finished and archived, untouched for ${age} (before ${day(plan.cutoff)}):`,
    "",
    `  ${count(plan.tasks, "task")}   ${states(plan)}`,
    `  ${count(plan.events, "activity record")}, about ${bytes(plan.bytes)}`,
    "",
    KEPT,
  ]));
  if (plan.heldBack > 0) {
    lines.push(
      "",
      `Holding back ${count(plan.heldBack, "task")} that fanned work out to runs that have not`,
      "finished, so each batch keeps the task it started from.",
    );
  }
  if (last) {
    lines.push(
      "",
      `Last cleanup, ${day(last.finishedAt)}: removed ${count(last.events, "activity record")} ` +
      `from ${count(last.tasks, "task")}.`,
    );
  }
  if (!nothing) {
    lines.push(
      "",
      "To delete it permanently, with nothing to restore from:",
      `  inter cleanup --older-than ${args.olderThanDays}d --delete`,
    );
  }
  return lines.join("\n");
}

/**
 * Why a pass would take nothing, or `undefined` when it would take something.
 * A task can be eligible and still have no activity left — a second cleanup at
 * the same retention is the ordinary way to get there — and offering to delete
 * from it would be an invitation to destroy nothing.
 */
function nothingToDelete(plan: CleanupPlan, age: string): string | undefined {
  if (plan.events > 0) return undefined;
  return plan.tasks === 0
    ? `No task has finished, been archived, and gone untouched for ${age}.`
    : `The finished, archived work older than ${age} has no activity left to delete.`;
}

export function deletedReport(result: CleanupResult, olderThanDays: number): string {
  const age = `${olderThanDays} day${olderThanDays === 1 ? "" : "s"}`;
  const nothing = nothingToDelete(result, age);
  if (nothing) return `Nothing was deleted. ${nothing}`;
  return [
    `Deleted the activity of ${count(result.tasks, "task")}: ${states(result)}.`,
    `${count(result.events, "activity record")} removed. Database file ${
      bytes(result.fileBytesBefore)} to ${bytes(result.fileBytesAfter)}.`,
    "",
    KEPT,
  ].join("\n");
}

/** One line for the broker log, since nobody is watching an automatic pass. */
export function cleanupLogLine(result: CleanupResult): string {
  return `cleanup: removed ${count(result.events, "activity record")} from ${
    count(result.tasks, "task")} archived before ${day(result.cutoff)}; file ${
    bytes(result.fileBytesBefore)} to ${bytes(result.fileBytesAfter)}`;
}

/**
 * The retention an automatic cleanup runs at, or nothing at all. Unset is the
 * shipped state: no pass is scheduled and no task ever loses its activity
 * without someone typing the command. A value that is not a usable number of
 * days throws rather than being ignored — a retention the maintainer believes
 * is in force but is not is the worst of the three outcomes.
 */
export function scheduledCleanupDays(env: Record<string, string | undefined> = Bun.env): number | undefined {
  const raw = env.INTER_CLEANUP_DAYS?.trim();
  if (!raw) return undefined;
  const days = parseDays(raw);
  if (days === undefined) {
    throw new CliRefusal(
      `INTER_CLEANUP_DAYS must be a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}, got: ${raw}`,
    );
  }
  return days;
}

export function startScheduledCleanup(store: StateStore, days: number, log = console.log): void {
  log(
    `automatic cleanup on: tasks finished and archived more than ${days} days ago lose their ` +
    `recorded activity. First pass in ${FIRST_PASS_DELAY_MS / 60_000} minutes, then daily.`,
  );
  const pass = () => {
    try {
      const result = store.deleteSettledTaskActivity(cutoffFor(days));
      // A pass that removed nothing is the normal case once the backlog is
      // gone; saying so daily would train the reader to skip the line that
      // matters.
      if (result.events > 0) log(cleanupLogLine(result));
    } catch (error) {
      log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(() => {
    pass();
    setInterval(pass, PASS_INTERVAL_MS).unref?.();
  }, FIRST_PASS_DELAY_MS);
  first.unref?.();
}

export function runCleanup(argv: readonly string[]): number {
  const parsed = parseCleanupArgs(argv);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${cleanupUsage()}`);
    return 2;
  }
  // Write-capable but not the broker: opening this as the broker would settle
  // every task a running broker is driving, which for a disk-space command
  // would be a catastrophic way to free some bytes.
  const store = new StateStore({ maintenance: true });
  try {
    const cutoff = cutoffFor(parsed.olderThanDays);
    if (!parsed.execute) {
      console.log(previewReport(store.cleanupPlan(cutoff), parsed, store.lastCleanup()));
      return 0;
    }
    console.log(deletedReport(store.deleteSettledTaskActivity(cutoff), parsed.olderThanDays));
    return 0;
  } finally {
    store.close();
  }
}

function states(plan: CleanupPlan): string {
  return plan.byState.map(({ state, tasks }) => `${tasks} ${state}`).join(" · ");
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function bytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  const units = ["kB", "MB", "GB"];
  let scaled = value / 1_000;
  let unit = 0;
  while (scaled >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}
