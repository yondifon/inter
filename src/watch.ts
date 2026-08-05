import { basename, join } from "node:path";
import { unknownTaskMessage, waitForTasks } from "./tasks";
import { settled } from "./public-task";
import { databasePath, observeStateStore } from "./store";
import {
  connectEventSocket,
  eventSocketPath,
  SocketConnectError,
  SocketErrorFrame,
  SocketStreamDeath,
} from "./event-socket";
import { MCP_CONTRACT_VERSION, VERSION } from "./version";
import type { Task, TaskState } from "./types";

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
 *
 * When the broker is running, watch prefers its unix-domain event socket for
 * instant push delivery with zero database access. When the socket is absent or
 * dies mid-run, it falls back to the same DB-polling loop this command always
 * used — resuming from the same event cursor so nothing is lost or repeated.
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
 * drift apart. It is derived rather than written down because the name depends
 * on how this process started: `make install` links the compiled binary onto
 * PATH as `inter`, and a checkout has no such link. A description naming a
 * command that does not exist is worse than one naming a longer command that
 * does.
 */
export function watchCommand(
  taskIds = "<taskId>",
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  // argv[1] is how this process was actually started — except in a compiled
  // binary, where Bun rewrites it to the embedded script under /$bunfs, a
  // path that exists on nobody's disk. The binary's real name lives in
  // execPath then.
  const compiled = entry?.startsWith("/$bunfs/") === true;
  const name = compiled
    ? basename(execPath)
    : entry && basename(entry).replace(/\.[cm]?[jt]s$/, "");
  // The installed binary answers to `inter` whether it was launched through the
  // PATH link or as the bundle's `inter-server`.
  if (name === "inter" || name === "inter-server") return `inter watch ${taskIds}`;
  // A compiled binary under any other name is still runnable by its own path,
  // and that path is the only thing about it that exists on disk.
  if (compiled) return `${execPath} watch ${taskIds}`;
  return `bun run ${join(import.meta.dir, "cli.ts")} watch ${taskIds}`;
}

export function watchUsage(): string {
  return `usage: ${watchCommand("<taskId...>")} [--timeout 30m]\n` +
    "  Blocks until a task asks a question, fails, is cancelled, or completes.\n" +
    "  Prints JSON lines — type \"event\" as they stream, type \"settled\" per task. Exit 0 with news, 1 on timeout, 2 on bad input.";
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
 * One JSON line per task that settled: the id, the state, and the question or
 * error if there is one. A task that is still running gets no line from here;
 * what it is doing arrives as event lines instead.
 */
export function watchLine(task: Task): string {
  const line: Record<string, unknown> = { type: "settled", task: task.id, state: task.state };
  // needs_input answers with its question, every other settled state with its
  // error — the same pairing the prose line used.
  const detail = task.state === "needs_input" ? task.question : task.error;
  const trimmed = detail?.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  if (trimmed) line[task.state === "needs_input" ? "question" : "error"] = trimmed;
  // Watching a fan-out printed N bare UUIDs, so telling them apart cost an
  // `inspect` per id — giving back the saving the command exists to create.
  const title = task.title?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (title) line.title = title;
  // An archived id still resolves and still settles; saying so is what keeps
  // it distinguishable from an id this store has never heard of.
  if (task.archivedAt) line.archived = true;
  return JSON.stringify(line);
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

  // One deadline for the whole command rather than one per wait: a task that
  // keeps emitting must not be able to push the finish line back forever.
  const deadline = Date.now() + parsed.timeoutMs;

  // ---- Try the event socket first ----

  const sockResult = await trySocketRun(parsed.taskIds, deadline, out, err);
  if (typeof sockResult === "number") return sockResult;

  // ---- DB fallback ----

  return runDbLoop(parsed.taskIds, deadline, out, err, false, undefined, undefined, 0, sockResult.fallbackReason);
}

// ---- Socket attempt ----

/**
 * Tries the event socket. Returns a numeric exit code on success or fatal
 * error, or a fallback carrying WHY the socket was skipped — the fallback
 * itself stays silent, but if the store then fails too, an error naming only
 * the database sends whoever reads it down the wrong road. Both causes belong
 * in that message; tonight's two-hour diagnosis started with exactly this gap.
 */
async function trySocketRun(
  taskIds: string[],
  deadline: number,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number | { fallbackReason: string }> {
  let stream;
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { fallbackReason: "the deadline expired before connecting" };
    const connecting = connectEventSocket({
      path: eventSocketPath(),
      watch: taskIds,
      // Pass 0 — the server replays history, but we filter to events after
      // the initialCursor carried in the hello. A huge sentinel would break
      // the waiter's progress detection (it uses afterCursor as baseline).
      afterCursor: 0,
      hello: { version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION },
      onVersionWarn: (msg) => err(msg),
    });
    // Race the connect itself, not just the per-batch reads below: a broker
    // that is slow (not absent) to answer must not let --timeout overshoot
    // while still inside connectEventSocket.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      connecting.then((s) => ({ timedOut: false as const, stream: s })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (raced.timedOut) {
      // The connect may still land after we've moved on to the DB loop —
      // close it then so an in-process caller doesn't inherit a live socket
      // and silence timer (the same leak `finally`'s stream.close() below
      // prevents for the mainline path).
      connecting.then((s) => s.close()).catch(() => {});
      return { fallbackReason: `connecting to ${eventSocketPath()} outlasted the deadline` };
    }
    stream = raced.stream;
  } catch (e) {
    if (e instanceof SocketConnectError) {
      return { fallbackReason: `no event socket at ${eventSocketPath()} (${e.message})` };
    }
    if (e instanceof SocketErrorFrame) {
      err(e.message);
      return 2;
    }
    throw e;
  }

  // Socket mode: never open the store. Filtering and printing are identical
  // to the DB path; the batch shapes are the same.
  const pending = new Set(taskIds);
  // Start from the cursor the server reports — events before this arrived
  // before the watcher attached and belong to `inspect`.
  let cursor = stream.hello.initialCursor ?? 0;
  let settledCount = 0;

  // A manual iterator instead of for-await, because each read races the
  // deadline: batches only arrive on events or keepalives, and a deadline
  // checked on arrival alone could overshoot `--timeout` by a whole keepalive.
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next(),
        new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), remaining); }),
      ]).finally(() => clearTimeout(timer));
      if (result === "deadline" || result.done) break;
      const batch = result.value;
      // Events at or before the attach-time cursor are history; they belong
      // to `inspect`, not to this watcher.
      const fresh = batch.events.filter((e) => e.id > cursor);
      cursor = processStreamedEvents(fresh, cursor, out);
      cursor = Math.max(cursor, batch.cursor);
      if (batch.hasMore) continue;
      settledCount += settleCompleted(batch.tasks, pending, out);
      if (pending.size === 0) break;
    }
  } catch (e) {
    if (e instanceof SocketStreamDeath) {
      err(`event socket lost: ${e.message}; falling back to database`);
      // Resume from THIS loop's cursor, not e.lastCursor: the client advances
      // its cursor as frames are enqueued, and death drops any frames still
      // queued — resuming from lastCursor would skip their events. This cursor
      // tracks exactly what was printed. Settles carry over too, so a task
      // that settled over the socket still counts when the DB phase ends with
      // nothing new.
      return runDbLoop(taskIds, deadline, out, err, true, cursor, pending, settledCount);
    }
    throw e;
  } finally {
    // The CLI exits the process, but an in-process caller — every test — would
    // otherwise leak the connection and its silence timer. No-op after death.
    stream.close();
  }

  return settledCount > 0 ? 0 : 1;
}

// ---- DB loop ----

async function runDbLoop(
  taskIds: string[],
  deadline: number,
  out: (line: string) => void,
  err: (line: string) => void,
  /** True when this is a mid-run failover from the socket. */
  isFailover: boolean,
  /** Only meaningful when isFailover: the last cursor from the socket. */
  failoverCursor?: number,
  /** Only meaningful when isFailover: the surviving pending set. */
  failoverPending?: Set<string>,
  /** Only meaningful when isFailover: settles already printed over the socket. */
  failoverSettled = 0,
  /** Why the socket path was skipped, for the one error that needs both causes. */
  socketNote?: string,
): Promise<number> {
  let store;
  try {
    store = observeStateStore();
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    // The silent fallback earns its silence only while the DB answers. When
    // both transports are down, an error naming only the database points the
    // reader at the wrong half of the problem.
    if (socketNote) err(`event socket was also unavailable: ${socketNote}`);
    return 2;
  }

  let cursor: number;
  let pending: Set<string>;
  let settledCount: number;

  if (isFailover) {
    // Resume from the socket's last cursor. The ids were already validated by
    // the server; no unknown-id check here.
    cursor = failoverCursor!;
    pending = failoverPending!;
    settledCount = failoverSettled;
  } else {
    // Fresh DB start: validate ids and pick up the current cursor.
    const missing = taskIds.filter((id) => !store.getTask(id));
    if (missing.length > 0) {
      err(`${unknownTaskMessage(missing.join(", "))} (searched ${databasePath()})`);
      return 2;
    }
    // Where the log stands at attach time. Starting from zero instead would
    // replay the whole trace, which runs to thousands of rows on a long task
    // and is what `inspect` is for; a watcher came for what happens next.
    cursor = store.latestTaskEventId(taskIds, true);
    pending = new Set(taskIds);
    settledCount = 0;
  }

  while (pending.size > 0) {
    // What is left of the budget, so the loop can never outlive `--timeout`.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let waited;
    try {
      waited = await waitForTasks([...pending], remaining, undefined, cursor, "progress");
    } catch (error) {
      err(String(error instanceof Error ? error.message : error));
      return 2;
    }

    cursor = processStreamedEvents(waited.events, cursor, out);
    cursor = Math.max(cursor, waited.cursor);
    // More rows than one batch carries: go straight back for the rest instead
    // of waiting, and hold the settle line until the trace behind it is out.
    if (waited.hasMore) continue;

    settledCount += settleCompleted(waited.tasks, pending, out);
  }

  return settledCount > 0 ? 0 : 1;
}

// ---- Shared per-batch processing (socket and DB paths are identical) ----

/**
 * Prints one JSON line per streamed event, advances the cursor past skipped
 * rows too, and returns the new cursor.
 */
function processStreamedEvents(
  events: Array<{ id: number; taskId: string; kind: string; minor?: boolean; summary: string }>,
  currentCursor: number,
  out: (line: string) => void,
): number {
  let cursor = currentCursor;
  for (const event of events) {
    // Skipped events move the cursor too. Leaving one behind would make the
    // next wait return on it at once, and the loop would spin on a row it has
    // already decided not to print.
    cursor = Math.max(cursor, event.id);
    // A step boundary or a quiet heartbeat is plumbing even though it is
    // lifecycle, so `minor` has to clear as well as the kind.
    if (STREAMED_KINDS.has(event.kind) && !event.minor) out(eventLine(event));
  }
  return cursor;
}

/**
 * Removes settled tasks from the pending set, prints their watch lines, and
 * returns how many settled.
 */
function settleCompleted(
  tasks: Array<{ id: string; state: string; question?: string; error?: string; title?: string; archivedAt?: string }>,
  pending: Set<string>,
  out: (line: string) => void,
): number {
  let count = 0;
  for (const task of tasks) {
    if (!pending.has(task.id) || !settled(task.state as TaskState)) continue;
    // Dropping it from the wait set is what keeps the loop asleep. The waiter
    // returns the instant any of its ids needs attention, so a settled id left
    // in would come back immediately forever while its siblings still run.
    pending.delete(task.id);
    count += 1;
    out(watchLine(task as Task));
  }
  return count;
}

/**
 * An event as one JSON line: the kind, the full task id — always present, so a
 * fan-out's lines stay attributable without a second look — and the summary the
 * trace already renders, collapsed onto a single line and cut to the width a
 * settled line uses.
 */
function eventLine(event: { taskId: string; kind: string; summary: string }): string {
  const text = event.summary.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return JSON.stringify({ type: "event", kind: event.kind, task: event.taskId, text });
}
