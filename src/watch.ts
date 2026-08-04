import { basename, join } from "node:path";
import { unknownTaskMessage, waitForTasks } from "./tasks";
import { settled } from "./public-task";
import { databasePath, observeStateStore } from "./store";
import type { Task } from "./types";

/**
 * `inter watch` is the floor under follow-along. An MCP `wait` is request and
 * response inside the caller's turn, so a caller that blocks on one can do
 * nothing else while it blocks, and pays tokens for every payload it gets back.
 * A backgrounded process still sleeps for free, and the client's own shell
 * facility does the notifying when it exits.
 *
 * What it does now cost is the reading. Silence was free but it was also
 * useless: a human ten minutes into a blank terminal cannot tell a working task
 * from a wedged one, and neither can an agent tailing the log. So events go out
 * as they happen — one line each, the plumbing folded away — and whoever reads
 * that log back pays for those lines. Deliberate, and still bounded: the exit
 * code alone carries the news for anything that only reads `$?`.
 */
export const DEFAULT_WATCH_TIMEOUT_MS = 30 * 60_000;
const MAX_WATCH_TIMEOUT_MS = 86_400_000;
/** Long enough to carry a real question, short enough to stay one line. */
const MAX_DETAIL = 200;
/**
 * What a watcher came for: that the task is alive, what it is waiting on, and
 * what went wrong. Lifecycle and error rows carry exactly that. Every other
 * kind is the worker doing its job — the files it read, the commands it ran,
 * its prose, its token tickers — and nobody tails a task to read its keystrokes.
 */
const STREAMED_KINDS = new Set(["lifecycle", "error"]);
/** Enough to tell a fan-out's tasks apart without wrapping the line. */
const MAX_TITLE = 80;

/**
 * The one place that says how to start this command, so the usage text and the
 * `wait` tool description — the only pointer an MCP caller ever sees — cannot
 * drift apart. It is derived rather than written down because `inter` is not on
 * PATH: `package.json` declares a `bin` that nothing links, and `make install`
 * ships an app bundle, not a CLI. A description naming a command that does not
 * exist is worse than one naming a longer command that does.
 */
export function watchCommand(taskIds = "<taskId>"): string {
  // argv[1] is how this process was actually started, so someone who did link
  // the bin gets `inter` and this checkout gets the invocation that works in it.
  const entry = process.argv[1];
  const command = entry && basename(entry).replace(/\.[cm]?[jt]s$/, "") === "inter"
    ? "inter"
    : `bun run ${join(import.meta.dir, "cli.ts")}`;
  return `${command} watch ${taskIds}`;
}

export function watchUsage(): string {
  return `usage: ${watchCommand("<taskId...>")} [--timeout 30m]\n` +
    "  Blocks until a task asks a question, fails, is cancelled, or completes.\n" +
    "  Prints one line per settled task. Exit 0 with news, 1 on timeout, 2 on bad input.";
}

interface WatchArgs {
  taskIds: string[];
  timeoutMs: number;
}

/**
 * Plain by design — the repo has no CLI framework and one flag does not justify
 * one. A bare number is milliseconds, so the flag reads the same way every
 * other timeout in the codebase does; the suffixes exist because a human types
 * this by hand.
 */
export function parseWatchArgs(argv: readonly string[]): WatchArgs | { error: string } {
  const taskIds: string[] = [];
  let timeoutMs = DEFAULT_WATCH_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--timeout" || arg === "-t") {
      const value = argv[index += 1];
      if (value === undefined) return { error: "--timeout needs a value" };
      const parsed = parseDuration(value);
      if (parsed === undefined) return { error: `not a duration: ${value}` };
      timeoutMs = parsed;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const parsed = parseDuration(arg.slice("--timeout=".length));
      if (parsed === undefined) return { error: `not a duration: ${arg}` };
      timeoutMs = parsed;
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    taskIds.push(arg);
  }

  if (taskIds.length === 0) return { error: "at least one task id is required" };
  return { taskIds, timeoutMs };
}

function parseDuration(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return undefined;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "ms"]!;
  const ms = Number(match[1]) * scale;
  if (ms <= 0 || ms > MAX_WATCH_TIMEOUT_MS) return undefined;
  return ms;
}

/**
 * One line per task that settled: the id, the state, and the question or error
 * if there is one. A task that is still running gets no line from here; what it
 * is doing arrives as event lines instead.
 */
export function watchLine(task: Task): string {
  const detail = task.state === "needs_input" ? task.question : task.error;
  const trimmed = detail?.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  // Watching a fan-out printed N bare UUIDs, so telling them apart cost an
  // `inspect` per id — giving back the saving the command exists to create.
  const title = task.title?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return [
    task.id,
    task.state,
    // An archived id still resolves and still settles; saying so is what keeps
    // it distinguishable from an id this store has never heard of.
    ...(task.archivedAt ? ["(archived)"] : []),
    ...(trimmed ? [trimmed] : []),
    ...(title ? [`— ${title}`] : []),
  ].join(" ");
}

/**
 * Exit codes carry the news on their own, so a caller that only reads `$?`
 * still learns whether it was woken by a task or by the deadline:
 * 0 something settled, 1 timed out with nothing, 2 bad input or unknown task.
 */
export async function runWatch(
  argv: readonly string[],
  out: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if ("error" in parsed) {
    err(parsed.error);
    err(watchUsage());
    return 2;
  }

  // Before anything else touches the store: opening it as the broker would run
  // interrupted-task recovery and fail the very tasks being watched.
  const store = observeStateStore();

  // An id this store has never held is a typo or a look in the wrong database,
  // and the caller cannot tell which without being told where the search ran.
  // An archived id is not in this set — it resolves, and `watchLine` marks it.
  const missing = parsed.taskIds.filter((id) => !store.getTask(id));
  if (missing.length > 0) {
    err(`${unknownTaskMessage(missing.join(", "))} (searched ${databasePath()})`);
    return 2;
  }

  // One deadline for the whole command rather than one per wait: a task that
  // keeps emitting must not be able to push the finish line back forever.
  const deadline = Date.now() + parsed.timeoutMs;
  // Only a fan-out has to be told whose event this is; a single watch knows.
  const labelled = parsed.taskIds.length > 1;
  const pending = new Set(parsed.taskIds);
  // Where the log stands at attach time. Starting from zero instead would
  // replay the whole trace, which runs to thousands of rows on a long task and
  // is what `inspect` is for; a watcher came for what happens next.
  let cursor = store.latestTaskEventId(parsed.taskIds, true);
  let settledCount = 0;

  while (pending.size > 0) {
    // What is left of the budget, so the loop can never outlive `--timeout`.
    // `parseDuration` caps that at a day, well inside the range of the timer
    // the waiter arms with it.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let waited;
    try {
      // `until: "progress"` is what turns the one blocking wait into a stream:
      // it comes back on the next event as well as on a question or a terminal
      // state, so a long deadline is still safe.
      waited = await waitForTasks([...pending], remaining, undefined, cursor, "progress");
    } catch (error) {
      err(String(error instanceof Error ? error.message : error));
      return 2;
    }

    for (const event of waited.events) {
      // Skipped events move the cursor too. Leaving one behind would make the
      // next wait return on it at once, and the loop would spin on a row it has
      // already decided not to print.
      cursor = Math.max(cursor, event.id);
      // A step boundary or a quiet heartbeat is plumbing even though it is
      // lifecycle, so `minor` has to clear as well as the kind.
      if (STREAMED_KINDS.has(event.kind) && !event.minor) out(eventLine(event, labelled));
    }
    cursor = Math.max(cursor, waited.cursor);
    // More rows than one batch carries: go straight back for the rest instead
    // of waiting, and hold the settle line until the trace behind it is out.
    if (waited.hasMore) continue;

    for (const task of waited.tasks) {
      if (!pending.has(task.id) || !settled(task.state)) continue;
      // Dropping it from the wait set is what keeps the loop asleep. The waiter
      // returns the instant any of its ids needs attention, so a settled id left
      // in would come back immediately forever while its siblings still run.
      pending.delete(task.id);
      settledCount += 1;
      out(watchLine(task));
    }
  }

  return settledCount > 0 ? 0 : 1;
}

/**
 * An event as one line: the summary the trace already renders, collapsed onto a
 * single line and cut to the width a settled line uses. The id goes in front
 * only for a fan-out, which is the only case that cannot tell otherwise.
 */
function eventLine(event: { taskId: string; summary: string }, withTaskId: boolean): string {
  const summary = event.summary.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return withTaskId ? `${event.taskId.slice(0, 8)} ${summary}` : summary;
}
