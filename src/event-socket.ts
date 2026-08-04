import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { databasePath, stateStore } from "./store";
import { unknownTaskMessage, waitForTasks, type WaitedTaskEvent } from "./tasks";
import type { Task, TaskState } from "./types";

// ---- Frame types (EC-001) ----

/** client→server, one NDJSON line. Unknown keys are ignored. */
export interface SubscribeFrame {
  v: 1;
  watch: string[];
  afterCursor: number;
}

/** server→client. Unknown keys are ignored. */
export interface HelloFrame {
  hello: {
    version: string;
    mcpContractVersion: number;
    /** Current max event cursor for the subscribed task set, so a client can
     * skip history without opening the store. Clients that don't recognise
     * this key ignore it (EC-001). */
    initialCursor?: number;
  };
}

export interface BatchEvent {
  id: number;
  taskId: string;
  kind: string;
  minor?: boolean;
  state: TaskState;
  at: string;
  summary: string;
}

export interface BatchTask {
  id: string;
  state: TaskState;
  question?: string;
  error?: string;
  title?: string;
  archivedAt?: string;
}

/** server→client. Unknown keys are ignored. */
export interface BatchFrame {
  events: BatchEvent[];
  tasks: BatchTask[];
  cursor: number;
  hasMore: boolean;
}

/** server→client, then connection closes. Unknown keys are ignored. */
export interface ErrorFrame {
  error: string;
}

// ---- Socket path (EC-003) ----

/** 103 bytes: macOS sun_path limit (104 minus one NUL). */
const MAX_SOCK_PATH = 103;

export function eventSocketPath(): string {
  return Bun.env.INTER_SOCK ?? join(dirname(databasePath()), "inter.sock");
}

// ---- Per-connection state stored on socket.data ----

interface ConnState {
  ac: AbortController;
  buf: string;
  helloed: boolean;
  taskIds: string[];
  cursor: number;
  /** Bytes the kernel refused: Bun does not buffer an unaccepted tail, so
   * dropping it would corrupt the NDJSON stream mid-frame. Held here and
   * flushed on drain; the wait loop pauses while any of it is outstanding. */
  pending: Uint8Array | undefined;
  /** Resolves the wait loop's pause once `pending` has fully flushed. */
  drained: (() => void) | undefined;
}

/** A reader this far behind is stalled, and holding its backlog would let one
 * dead client grow broker memory without bound. Past this, the connection is
 * dropped; the client's own DB fallback makes that safe. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

// ---- Server ----

export interface EventSocketOptions {
  /** Socket path. Defaults to `eventSocketPath()`. */
  path?: string;
  /** The hello payload the server sends on every successful subscribe. */
  hello: HelloFrame["hello"];
  /** Milliseconds between keepalive batches on quiet tasks (default: 30_000). */
  keepaliveMs?: number;
}

export interface EventSocketHandle {
  /** The path the server bound, or undefined when the socket was skipped. */
  path: string | undefined;
  /** Stops the server, aborts every open connection, and unlinks the file. */
  stop: () => void;
}

/**
 * Binds a unix-domain socket that pushes task-event batches to local
 * subscribers. The port bind in cli.ts is the single-instance lock (D-007), so
 * the stale-file unlink here can never steal a live broker's socket.
 */
export function startEventSocket(options: EventSocketOptions): EventSocketHandle {
  const path = options.path ?? eventSocketPath();
  const keepaliveMs = options.keepaliveMs ?? 30_000;

  if (Buffer.byteLength(path) > MAX_SOCK_PATH) {
    console.warn(
      `event socket path too long (${Buffer.byteLength(path)} > ${MAX_SOCK_PATH} bytes): ${path} — skipping socket`,
    );
    return { path: undefined, stop: () => {} };
  }

  // Unlink a stale file left by a previous crash (D-007: port binds first).
  try { unlinkSync(path); } catch {}

  // Track all live connection states so stop() can abort every wait loop.
  const liveStates = new Set<ConnState>();

  const listener = Bun.listen<ConnState>({
    unix: path,
    socket: {
      open(socket) {
        const ac = new AbortController();
        const state: ConnState = {
          ac,
          buf: "",
          helloed: false,
          taskIds: [],
          cursor: 0,
          pending: undefined,
          drained: undefined,
        };
        socket.data = state;
        liveStates.add(state);
      },

      data(socket, chunk) {
        const state = socket.data;
        state.buf += new TextDecoder().decode(chunk as Uint8Array);
        const lines = state.buf.split("\n");
        // Keep the potentially incomplete last piece.
        state.buf = lines.pop() ?? "";

        for (const raw of lines) {
          if (!raw.trim()) continue;
          if (!state.helloed) {
            state.helloed = true;
            handleSubscribe(socket, state, raw);
            continue;
          }
          // After subscribe, the server only writes; any client data after
          // the first line is ignored per the protocol.
        }
      },

      drain(socket) {
        const state = socket.data;
        if (!state.pending) return;
        const written = socket.write(state.pending);
        if (written >= state.pending.byteLength) {
          state.pending = undefined;
          state.drained?.();
          state.drained = undefined;
        } else if (written > 0) {
          state.pending = state.pending.subarray(written);
        }
      },

      close(socket) {
        const state = socket.data;
        state.ac.abort();
        state.drained?.();
        liveStates.delete(state);
      },

      error(socket, _err) {
        const state = socket.data;
        state.ac.abort();
        state.drained?.();
        liveStates.delete(state);
      },
    },
  });

  return {
    path,
    stop: () => {
      for (const state of liveStates) {
        state.ac.abort();
        // A loop paused awaiting `drained` (backpressure) has no other way to
        // notice the abort: only a socket `drain`, `close`, or `error` event
        // resolves that promise, and none of those fire just because the
        // AbortController did. Resolve it here too, same as the close/error
        // handlers already do, so the loop can reach its aborted check and
        // exit instead of outliving stop().
        state.drained?.();
      }
      liveStates.clear();
      listener.stop();
      try { unlinkSync(path); } catch {}
    },
  };

  // ---- Per-connection protocol handling ----

  function handleSubscribe(
    socket: { data: ConnState; write(data: string | Uint8Array): number; end?(): void },
    state: ConnState,
    raw: string,
  ): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      writeError(socket, state, "invalid JSON subscribe frame");
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      writeError(socket, state, "subscribe frame must be an object");
      return;
    }
    const watch = frame.watch;
    if (!Array.isArray(watch) || watch.length === 0) {
      writeError(socket, state, "subscribe frame must contain a non-empty watch array");
      return;
    }
    for (const id of watch) {
      if (typeof id !== "string") {
        writeError(socket, state, "subscribe watch array must contain string task ids");
        return;
      }
    }
    const store = stateStore();
    for (const id of watch) {
      if (!store.getTask(id)) {
        writeError(socket, state, unknownTaskMessage(id));
        return;
      }
    }
    state.taskIds = watch as string[];
    state.cursor = typeof frame.afterCursor === "number" && Number.isFinite(frame.afterCursor)
      ? Math.max(0, Math.floor(frame.afterCursor))
      : 0;

    // Hello frame first. Include the current cursor so a client that passed
    // a large afterCursor ("start from now") can skip history correctly.
    const initialCursor = store.latestTaskEventId(watch as string[], true);
    const hello: HelloFrame = {
      hello: { ...options.hello, initialCursor },
    };
    writeFrame(socket, state, JSON.stringify(hello));

    // Start the wait→batch loop; do not await — it runs asynchronously.
    void runLoop(socket, state);
  }

  function writeFrame(
    socket: { data: ConnState; write(data: string | Uint8Array): number },
    state: ConnState,
    payload: string,
  ): boolean {
    const data = new TextEncoder().encode(payload + "\n");
    // An earlier frame is still queued: appending keeps frames whole and in
    // order, and the drain handler flushes the lot.
    if (state.pending) {
      state.pending = concatBytes(state.pending, data);
      return true;
    }
    let written: number;
    try {
      written = socket.write(data);
    } catch {
      return false;
    }
    if (written < 0) return false;
    if (written < data.byteLength) {
      state.pending = data.subarray(written);
    }
    return true;
  }

  function writeError(
    socket: { data: ConnState; write(data: string | Uint8Array): number; end?(): void },
    state: ConnState,
    message: string,
  ): void {
    const frame: ErrorFrame = { error: message };
    writeFrame(socket, state, JSON.stringify(frame));
    // The client closes the socket after receiving the error frame.
    // Closing here would race with data delivery — the close callback
    // might fire before the client's data callback sees the error.
  }

  async function runLoop(
    socket: { data: ConnState; write(data: string | Uint8Array): number; end?(): void },
    state: ConnState,
  ): Promise<void> {
    while (!state.ac.signal.aborted) {
      let waited;
      try {
        waited = await waitForTasks(
          state.taskIds,
          keepaliveMs,
          state.ac.signal,
          state.cursor,
          "progress",
        );
      } catch {
        // AbortError or store error — connection is done.
        break;
      }

      if (state.ac.signal.aborted) break;

      const batch: BatchFrame = {
        events: waited.events.map(eventToBatch),
        tasks: waited.tasks.map(taskToBatch),
        cursor: waited.cursor,
        hasMore: waited.hasMore ?? false,
      };

      state.cursor = waited.cursor;

      if (!writeFrame(socket, state, JSON.stringify(batch))) {
        // Write failed — client disconnected.
        break;
      }

      // A slow reader pauses the loop rather than growing the backlog; a
      // stalled one is dropped, which its DB fallback makes safe.
      if (state.pending) {
        if (state.pending.byteLength > MAX_PENDING_BYTES) break;
        await new Promise<void>((resolve) => { state.drained = resolve; });
        if (state.ac.signal.aborted) break;
      }

      // hasMore: go straight back for the next chunk without waiting.
      if (waited.hasMore) continue;
    }

    // Cleanup: if the loop ended on its own (e.g. abort or write failure),
    // close the socket so the client detects the death and fails over. The
    // close/error handlers are idempotent with this.
    state.ac.abort();
    liveStates.delete(state);
    try { socket.end?.(); } catch { /* socket already gone */ }
  }
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head, 0);
  joined.set(tail, head.byteLength);
  return joined;
}

function eventToBatch(event: WaitedTaskEvent): BatchEvent {
  return {
    id: event.id,
    taskId: event.taskId,
    kind: event.kind,
    ...(event.minor ? { minor: event.minor } : {}),
    state: event.state,
    at: event.at,
    summary: event.summary,
  };
}

function taskToBatch(task: Task): BatchTask {
  return {
    id: task.id,
    state: task.state,
    ...(task.question ? { question: task.question } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.title ? { title: task.title } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
  };
}

// ---- Client ----

/** Connect refused, ENOENT, path too long, or socket dies before the first batch. */
export class SocketConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketConnectError";
  }
}

/** Server refused the subscribe — its message belongs on stderr. */
export class SocketErrorFrame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketErrorFrame";
  }
}

/** Stream died mid-run (EOF, error, or 90s silence). `lastCursor` is the last
 * cursor ENQUEUED, which can run ahead of what the consumer has read — frames
 * still queued at death are dropped. A consumer that tracks its own cursor per
 * processed batch must resume from that, not from this. */
export class SocketStreamDeath extends Error {
  lastCursor: number;
  constructor(message: string, lastCursor: number) {
    super(message);
    this.name = "SocketStreamDeath";
    this.lastCursor = lastCursor;
  }
}

/** An open event-socket stream. Iterate to receive {@link BatchFrame}s. */
export interface SocketStream {
  hello: HelloFrame["hello"];
  [Symbol.asyncIterator](): AsyncIterator<BatchFrame>;
  /**
   * Ends the connection and its silence timer without an error: the iterator
   * finishes cleanly. The CLI exits the process and never needs this; an
   * in-process caller — a test, or a future embedder — would otherwise leak
   * the socket and a live timer per run.
   */
  close(): void;
}

export interface ConnectEventSocketOptions {
  path: string;
  watch: string[];
  afterCursor: number;
  /** This binary's hello values — checked against the server's. */
  hello: HelloFrame["hello"];
  /** Called on mcpContractVersion mismatch (warning, never fatal). */
  onVersionWarn?: (message: string) => void;
  /** Milliseconds without a frame before treating the broker as dead (default 90s). */
  silenceTimeoutMs?: number;
}

/**
 * Opens a unix-domain socket, subscribes to the given task ids, verifies the
 * server's hello, and returns a stream of {@link BatchFrame}s. Every error path
 * is a distinct throw so `runWatch` can branch cleanly:
 * - {@link SocketConnectError} — socket never existed (silent DB fallback).
 * - {@link SocketErrorFrame} — server rejected the subscribe (print and exit 2).
 * - {@link SocketStreamDeath} — mid-run death (warn and fall back from the same cursor).
 */
export async function connectEventSocket(opts: ConnectEventSocketOptions): Promise<SocketStream> {
  if (Buffer.byteLength(opts.path) > MAX_SOCK_PATH) {
    throw new SocketConnectError(
      `socket path too long (${Buffer.byteLength(opts.path)} > ${MAX_SOCK_PATH} bytes): ${opts.path}`,
    );
  }

  const silenceTimeoutMs = opts.silenceTimeoutMs ?? 90_000;

  type Phase = "connecting" | "subscribing" | "streaming" | "dead";
  let phase: Phase = "connecting";
  let buf = "";
  let cursor = opts.afterCursor;
  let batchesYielded = 0;
  /** The server's hello, captured when the subscribe response arrives. */
  let serverHello: HelloFrame["hello"] | null = null;

  // Promise plumbing: the connect promise resolves when the first batch
  // arrives (after hello verification). The async iterator resolves each
  // `.next()` call via a single-slot waiter.
  let connectResolve: (stream: SocketStream) => void;
  let connectReject: (err: Error) => void;
  let frameWaiter: { resolve: (value: IteratorResult<BatchFrame>) => void; reject: (err: Error) => void } | null = null;
  const frameQueue: BatchFrame[] = [];
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  // The connected socket, set after Bun.connect resolves.
  let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

  const connectPromise = new Promise<SocketStream>((resolve, reject) => {
    connectResolve = resolve;
    connectReject = reject;
  });

  function resetSilenceTimer(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const message = `no frame received for ${silenceTimeoutMs}ms`;
      // Silence before the first batch never established a stream, same as a
      // hard close/error in that window (see close/error below) — classify it
      // the same way so callers that only fall back on SocketConnectError
      // (trySocketRun's initial connect) don't see an uncaught throw instead.
      if (phase === "subscribing" || (phase === "streaming" && batchesYielded === 0)) {
        die(new SocketConnectError(message));
      } else {
        die(new SocketStreamDeath(message, cursor));
      }
    }, silenceTimeoutMs);
  }

  function die(err: Error): void {
    if (phase === "dead") return;
    phase = "dead";
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    try { sock?.end(); } catch { /* socket already gone */ }
    if (frameWaiter) {
      frameWaiter.reject(err);
      frameWaiter = null;
    }
    frameQueue.length = 0;
    // If the connect promise hasn't settled yet (no first batch), reject it.
    // After the first batch this is a no-op — the promise is already resolved.
    connectReject(err);
  }

  function closeStream(): void {
    if (phase === "dead") return;
    phase = "dead";
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    try { sock?.end(); } catch { /* socket already gone */ }
    frameQueue.length = 0;
    // A clean close finishes the iterator instead of erroring it.
    if (frameWaiter) {
      frameWaiter.resolve({ value: undefined as unknown as BatchFrame, done: true });
      frameWaiter = null;
    }
  }

  function enqueueFrame(frame: BatchFrame): void {
    cursor = frame.cursor;
    if (frameWaiter) {
      frameWaiter.resolve({ value: frame, done: false });
      frameWaiter = null;
    } else {
      frameQueue.push(frame);
    }
    batchesYielded += 1;
  }

  function nextFrame(): Promise<IteratorResult<BatchFrame>> {
    if (frameQueue.length > 0) {
      return Promise.resolve({ value: frameQueue.shift()!, done: false });
    }
    if (phase === "dead") {
      // die() already rejected any waiter; this path is for consumers that
      // call next() after the error was already surfaced.
      return Promise.reject(new SocketStreamDeath("stream already dead", cursor));
    }
    return new Promise((resolve, reject) => {
      frameWaiter = { resolve, reject };
    });
  }

  // The async iterator that the caller consumes.
  async function* frameGenerator(): AsyncGenerator<BatchFrame> {
    while (true) {
      const result = await nextFrame();
      if (result.done) break;
      yield result.value;
    }
  }

  // Bun.connect returns a Promise: resolves with the socket on success,
  // rejects on connection failure (ENOENT, ECONNREFUSED, etc.). The error
  // callback fires only for operational errors on a connected socket.
  try {
    sock = await Bun.connect({
      unix: opts.path,
      socket: {
        open(s) {
          phase = "subscribing";
          const sub: SubscribeFrame = { v: 1, watch: opts.watch, afterCursor: opts.afterCursor };
          s.write(JSON.stringify(sub) + "\n");
          resetSilenceTimer();
        },

        data(_s, chunk) {
          resetSilenceTimer();
          const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
          buf += text;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const raw of lines) {
            if (!raw.trim()) continue;
            let frame: Record<string, unknown>;
            try { frame = JSON.parse(raw); } catch { continue; }

            if (phase === "subscribing") {
              // First non-empty frame after subscribe.
              if ("error" in frame) {
                die(new SocketErrorFrame(String(frame.error)));
                return;
              }
              if ("hello" in frame && frame.hello && typeof frame.hello === "object") {
                const hello = frame.hello as Record<string, unknown>;
                serverHello = hello as unknown as HelloFrame["hello"];
                // Version mismatch is a warning, never fatal.
                if (typeof hello.mcpContractVersion === "number" &&
                    hello.mcpContractVersion !== opts.hello.mcpContractVersion) {
                  opts.onVersionWarn?.(
                    `event socket version mismatch: server ${String(hello.mcpContractVersion)}, client ${opts.hello.mcpContractVersion}`,
                  );
                }
                phase = "streaming";
                // Don't resolve yet — wait for the first batch so the caller
                // knows the stream is solid before iterating.
                continue;
              }
              // Unexpected frame after subscribe — ignore.
              continue;
            }

            if (phase === "streaming") {
              if ("events" in frame && "tasks" in frame) {
                const batch = frame as unknown as BatchFrame;
                if (batchesYielded === 0) {
                  // First batch: resolve the connect promise now.
                  // Push to queue and resolve in the right order.
                  frameQueue.push(batch);
                  cursor = batch.cursor;
                  batchesYielded = 1;
                  connectResolve({
                    hello: serverHello ?? opts.hello,
                    [Symbol.asyncIterator]: () => frameGenerator(),
                    close: closeStream,
                  });
                  // If the caller is already waiting via nextFrame(), wake them.
                  if (frameWaiter) {
                    const f = frameQueue.shift()!;
                    frameWaiter.resolve({ value: f, done: false });
                    frameWaiter = null;
                  }
                } else {
                  enqueueFrame(batch);
                }
              }
              // Unknown frame keys are ignored per EC-001.
            }
          }
        },

        close(_s) {
          if (phase === "subscribing" || (phase === "streaming" && batchesYielded === 0)) {
            die(new SocketConnectError("connection closed before first batch"));
          } else if (phase === "streaming") {
            die(new SocketStreamDeath("socket closed", cursor));
          } else if (phase === "connecting") {
            die(new SocketConnectError("connection closed"));
          }
        },

        error(_s, err) {
          const message = (err as Error)?.message ?? String(err);
          if (phase === "subscribing" || (phase === "streaming" && batchesYielded === 0)) {
            die(new SocketConnectError(message));
          } else if (phase === "streaming") {
            die(new SocketStreamDeath(message, cursor));
          } else {
            die(new SocketConnectError(message));
          }
        },
      },
    });
  } catch (err) {
    // Bun.connect rejects with a system error on ENOENT / ECONNREFUSED etc.
    throw new SocketConnectError(err instanceof Error ? err.message : String(err));
  }

  return connectPromise;
}
