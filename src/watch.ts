import { waitForTasks } from "./tasks";
import { settled } from "./public-task";
import { observeStateStore } from "./store";
import type { Task } from "./types";

/**
 * `inter watch` is the floor under follow-along. An MCP `wait` is request and
 * response inside the caller's turn, so a caller that blocks on one can do
 * nothing else while it blocks, and pays tokens for every payload it gets back.
 * A backgrounded process pays neither: it sleeps for free, and the client's own
 * shell facility does the notifying when it exits.
 *
 * So the whole contract is the exit code plus one line per task. Anything more
 * would put the cost back.
 */
export const DEFAULT_WATCH_TIMEOUT_MS = 30 * 60_000;
const MAX_WATCH_TIMEOUT_MS = 86_400_000;
/** Long enough to carry a real question, short enough to stay one line. */
const MAX_DETAIL = 200;

export const WATCH_USAGE =
  "usage: inter watch <taskId...> [--timeout 30m]\n" +
  "  Blocks until a task asks a question, fails, is cancelled, or completes.\n" +
  "  Prints one line per settled task. Exit 0 with news, 1 on timeout, 2 on bad input.";

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
 * if there is one. A task that is still running prints nothing — the point of
 * the command is that silence is free.
 */
export function watchLine(task: Task): string {
  const detail = task.state === "needs_input" ? task.question : task.error;
  const trimmed = detail?.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return trimmed ? `${task.id} ${task.state} ${trimmed}` : `${task.id} ${task.state}`;
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
    err(WATCH_USAGE);
    return 2;
  }

  // Before anything else touches the store: opening it as the broker would run
  // interrupted-task recovery and fail the very tasks being watched.
  observeStateStore();

  let waited;
  try {
    // `until: "attention"` is the whole reason a long deadline is safe: the wait
    // ends the instant a task needs someone, not when the clock runs out.
    waited = await waitForTasks(parsed.taskIds, parsed.timeoutMs, undefined, undefined, "attention");
  } catch (error) {
    err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const news = waited.tasks.filter((task) => settled(task.state));
  for (const task of news) out(watchLine(task));
  return news.length > 0 ? 0 : 1;
}
