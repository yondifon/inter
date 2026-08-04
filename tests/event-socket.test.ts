import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// All tests share one scratch dir. Set env vars before anything imports the
// store — the store's module-level `sharedStore` is created lazily, but once
// created it closes over the env at creation time.
// Socket names are kept short (1-2 chars + .sock) to stay under the macOS
// sun_path limit of 104 bytes even inside a deep TMPDIR.
const root = mkdtempSync(join(tmpdir(), "ist-"));

beforeAll(() => {
  process.env.INTER_DB = join(root, "inter.db");
  // Short path: well under the 104-byte sun_path limit. Some test cases
  // override this to test path-length handling.
  process.env.INTER_SOCK = join(root, "inter.sock");
});

// Imports after env vars are set so the store opens the test DB.
import { closeStateStore, stateStore } from "../src/store";
import {
  connectEventSocket,
  startEventSocket,
  eventSocketPath,
  SocketConnectError,
  SocketStreamDeath,
  type BatchFrame,
  type ErrorFrame,
  type HelloFrame,
  type SubscribeFrame,
} from "../src/event-socket";
import { appendTaskEvent } from "../src/tasks";
import type { Task } from "../src/types";

afterAll(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_SOCK;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh store per test: close, delete the file, let the next stateStore()
  // call re-create it.
  closeStateStore();
  try { rmSync(join(root, "inter.db"), { force: true }); } catch {}
  rmSync(join(root, "inter.db-shm"), { force: true });
  rmSync(join(root, "inter.db-wal"), { force: true });
  // Register a profile so task creation doesn't fail on the foreign key.
  stateStore().saveProfiles([{
    id: "test-profile",
    label: "Test",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
  }]);
});

afterEach(() => {
  closeStateStore();
});

/** A task seeded in the test store. */
function seedTask(state: "running" | "completed" | "failed" | "cancelled" | "needs_input", overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: "test-profile",
    model: "fake",
    prompt: "test",
    cwd: root,
    state,
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: [root], write: [root] },
    allowQuestions: true,
    ...overrides,
  };
  stateStore().createTask(task);
  return task;
}

// ---- Helpers for reading frames from a socket connection ----

interface Connection {
  socket: Awaited<ReturnType<typeof Bun.connect>>;
  /** Accumulated text from the socket. */
  text: string;
}

/** Open a unix-domain client and wait for the open callback. */
async function connect(path: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connect timed out")), 3_000);
    const conn: Connection = {
      socket: undefined as unknown as Awaited<ReturnType<typeof Bun.connect>>,
      text: "",
    };
    void Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          conn.socket = socket;
          clearTimeout(timeout);
          resolve(conn);
        },
        data(_socket, chunk) {
          conn.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        },
        close() {},
        error(_socket, err) {
          clearTimeout(timeout);
          reject(err);
        },
      },
    });
    // If connect fails synchronously (e.g., ENOENT), the error handler fires.
  });
}

/** Send a subscribe frame. */
function subscribe(conn: Connection, taskIds: string[], afterCursor = 0): void {
  const frame: SubscribeFrame = { v: 1, watch: taskIds, afterCursor };
  conn.socket.write(JSON.stringify(frame) + "\n");
}

/** Parse all NDJSON frames received so far. */
function frames(conn: Connection): Record<string, unknown>[] {
  return conn.text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait until the connection has at least `count` frames or `ms` passes. */
async function waitForFrames(conn: Connection, count: number, ms = 2_000): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = frames(conn);
    if (result.length >= count) return result;
    await Bun.sleep(30);
  }
  return frames(conn);
}

// ---- Tests ----

describe("event socket server", () => {
  test("subscribe → hello → live batch when an event is appended", async () => {
    const task = seedTask("running");
    const socketPath = join(root, "1.sock");

    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 5_000,
    });
    expect(handle.path).toBe(socketPath);

    try {
      const conn = await connect(socketPath);
      subscribe(conn, [task.id]);

      // Wait for hello + initial batch
      const initial = await waitForFrames(conn, 2, 1_000);
      const hello = initial[0] as unknown as HelloFrame;
      expect(hello.hello).toBeDefined();
      expect(hello.hello.version).toBe("0.0.0-test");

      // The initial batch may be empty (no events yet). Now append an event.
      appendTaskEvent(task.id, "worker_spawned", "running", { provider: "antigravity", model: "fake" });

      // Should get a batch with the event.
      const all = await waitForFrames(conn, 3, 1_000);
      const batch = all[2] as unknown as BatchFrame;
      expect(batch.events).toBeDefined();
      expect(batch.events.length).toBeGreaterThanOrEqual(1);

      const workerEvent = batch.events.find((e) => e.kind === "lifecycle");
      expect(workerEvent).toBeDefined();
      expect(workerEvent!.taskId).toBe(task.id);
      expect(workerEvent!.kind).toBe("lifecycle");
      expect(workerEvent!.summary).toBeDefined();
      expect(workerEvent!.state).toBe("running");
      // id, at should survive the wire.
      expect(typeof workerEvent!.id).toBe("number");
      expect(typeof workerEvent!.at).toBe("string");

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("replay: events before connect arrive when afterCursor is behind", async () => {
    const task = seedTask("running");
    // Append an event before the socket starts.
    appendTaskEvent(task.id, "worker_spawned", "running", { provider: "antigravity", model: "fake" });
    const cursor = stateStore().latestTaskEventId([task.id], true);

    const socketPath = join(root, "2.sock");
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 5_000,
    });

    try {
      const conn = await connect(socketPath);
      // afterCursor = 0: should replay the pre-existing event.
      subscribe(conn, [task.id], 0);

      const initial = await waitForFrames(conn, 2, 1_000);
      const hello = initial[0] as unknown as HelloFrame;
      expect(hello.hello).toBeDefined();

      const batch = initial[1] as unknown as BatchFrame;
      expect(batch.cursor).toBeGreaterThanOrEqual(cursor);

      const workerEvent = batch.events.find((e) => e.kind === "lifecycle");
      expect(workerEvent).toBeDefined();

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("no replay when afterCursor is current", async () => {
    const task = seedTask("running");
    appendTaskEvent(task.id, "worker_spawned", "running", { provider: "antigravity", model: "fake" });
    const cursor = stateStore().latestTaskEventId([task.id], true);

    const socketPath = join(root, "3.sock");
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 5_000,
    });

    try {
      const conn = await connect(socketPath);
      // afterCursor = cursor: should NOT replay the old event.
      subscribe(conn, [task.id], cursor);

      // Wait for hello only. The batch arrives on timeout (keepalive), but
      // should have no events.
      const afterHello = await waitForFrames(conn, 2, 2_000);
      expect(afterHello.length).toBeGreaterThanOrEqual(1);
      const hello = afterHello[0] as unknown as HelloFrame;
      expect(hello.hello).toBeDefined();

      if (afterHello.length >= 2) {
        const batch = afterHello[1] as unknown as BatchFrame;
        // Events from before connect should NOT appear.
        expect(batch.events.length).toBe(0);
      }

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("keepalive: quiet task yields an empty batch", async () => {
    const task = seedTask("running");
    const socketPath = join(root, "4.sock");

    // Short keepalive so the test doesn't wait.
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 200,
    });

    try {
      const conn = await connect(socketPath);
      subscribe(conn, [task.id]);

      // Wait for hello + initial batch + keepalive batch.
      // The initial batch carries the auto-created "Task queued" event.
      // The keepalive batch (the third frame) should be empty.
      const result = await waitForFrames(conn, 3, 2_000);
      expect(result.length).toBeGreaterThanOrEqual(3);

      // Skip hello (index 0) and the initial batch (index 1); verify the
      // keepalive batch (index 2) has empty events (no news) but still
      // carries the task state.
      const batch = result[2] as unknown as BatchFrame;
      expect(batch.events).toEqual([]);
      expect(batch.tasks.length).toBeGreaterThanOrEqual(1);
      expect(batch.tasks[0]!.id).toBe(task.id);
      expect(typeof batch.cursor).toBe("number");

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("unknown task id → error frame with unknownTaskMessage text, then close", async () => {
    const socketPath = join(root, "5.sock");
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
    });

    try {
      const conn = await connect(socketPath);
      subscribe(conn, ["no-such-task"]);

      const result = await waitForFrames(conn, 1, 1_000);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const error = result[0] as unknown as ErrorFrame;
      expect(error.error).toBeDefined();
      expect(error.error).toContain("unknown task");
      // Must contain the text from unknownTaskMessage.
      expect(error.error).toContain("no-such-task");
      expect(error.error).toContain("tasks");

      // Connection should close after error. We detect this by trying to
      // wait for more frames — none should arrive.
      await Bun.sleep(200);
      const after = frames(conn);
      expect(after.length).toBe(result.length); // No additional frames.

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("stale socket file: unlinks it and binds cleanly", async () => {
    const task = seedTask("running");
    const socketPath = join(root, "6.sock");

    // Create a dead socket file (just a regular file at the path).
    writeFileSync(socketPath, "dead socket content");

    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 5_000,
    });
    expect(handle.path).toBe(socketPath);

    try {
      // Should still be able to connect and get frames.
      const conn = await connect(socketPath);
      subscribe(conn, [task.id]);

      const result = await waitForFrames(conn, 1, 1_000);
      const hello = result[0] as unknown as HelloFrame;
      expect(hello.hello).toBeDefined();

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("over-long path: handle reports skipped, no bind", () => {
    // sun_path limit is 104 bytes (including NUL). Our guard is at 103.
    const actualPath = join(root, "a".repeat(104 - root.length + 1));

    const handle = startEventSocket({
      path: actualPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
    });

    expect(handle.path).toBeUndefined();
    // stop() should be a no-op, not throw.
    expect(() => handle.stop()).not.toThrow();
  });

  test("default path resolution via eventSocketPath", () => {
    const saved = process.env.INTER_SOCK;
    delete process.env.INTER_SOCK;

    try {
      // eventSocketPath should resolve next to the database.
      const path = eventSocketPath();
      expect(path).toContain("inter.sock");
      expect(path).toContain(dirname(root));
    } finally {
      if (saved) process.env.INTER_SOCK = saved;
      else delete process.env.INTER_SOCK;
    }
  });

  test("empty watch array → error frame", async () => {
    const socketPath = join(root, "7.sock");
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
    });

    try {
      const conn = await connect(socketPath);
      // Send a frame with an empty watch array.
      conn.socket.write(JSON.stringify({ v: 1, watch: [], afterCursor: 0 }) + "\n");

      const result = await waitForFrames(conn, 1, 1_000);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const error = result[0] as unknown as ErrorFrame;
      expect(error.error).toBeDefined();
      expect(error.error).toContain("watch");

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("validates that watch items are strings", async () => {
    const socketPath = join(root, "8.sock");
    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
    });

    try {
      const conn = await connect(socketPath);
      conn.socket.write(JSON.stringify({ v: 1, watch: [123], afterCursor: 0 }) + "\n");

      const result = await waitForFrames(conn, 1, 1_000);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const error = result[0] as unknown as ErrorFrame;
      expect(error.error).toBeDefined();

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });

  test("event fields id/taskId/kind/minor/summary survive the wire", async () => {
    const task = seedTask("running");
    const socketPath = join(root, "9.sock");

    const handle = startEventSocket({
      path: socketPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 1 },
      keepaliveMs: 5_000,
    });

    try {
      const conn = await connect(socketPath);
      subscribe(conn, [task.id]);

      // Wait for hello.
      await waitForFrames(conn, 1, 500);

      // Append an event with known fields.
      appendTaskEvent(task.id, "worker_spawned", "running", {
        provider: "antigravity",
        model: "fake",
      });

      const all = await waitForFrames(conn, 2, 1_000);
      const batch = all[1] as unknown as BatchFrame;
      expect(batch.events.length).toBeGreaterThanOrEqual(1);

      const evt = batch.events[0]!;
      // id must be a positive integer (a task_events rowid).
      expect(evt.id).toBeGreaterThan(0);
      expect(evt.taskId).toBe(task.id);
      expect(evt.kind).toBe("lifecycle");
      expect(evt.state).toBe("running");
      expect(typeof evt.at).toBe("string");
      expect(evt.summary.length).toBeGreaterThan(0);

      conn.socket.end();
    } finally {
      handle.stop();
    }
  });
});

/**
 * The client advances its death cursor as frames are ENQUEUED, and death drops
 * whatever is still queued — so `SocketStreamDeath.lastCursor` can point past
 * frames the consumer never saw. This test pins that semantic down: a consumer
 * that resumed from `lastCursor` would skip the dropped batch's events, which
 * is why `runWatch` fails over from its own processed cursor instead.
 */
describe("client stream death semantics", () => {
  test("lastCursor reflects enqueued frames, including ones death drops", async () => {
    const path = join(root, "d.sock");
    const batch = (id: number): string => JSON.stringify({
      events: [{ id, taskId: "t", kind: "lifecycle", state: "running", at: "now", summary: `e${id}` }],
      tasks: [],
      cursor: id,
      hasMore: false,
    }) + "\n";

    // A scripted server: hello plus two batches at once, then close shortly
    // after — while the consumer has only read the first.
    const server = Bun.listen({
      unix: path,
      socket: {
        data(socket) {
          socket.write(JSON.stringify({ hello: { version: "0", mcpContractVersion: 21 } }) + "\n");
          socket.write(batch(10) + batch(20));
          setTimeout(() => socket.end(), 150);
        },
        open() {},
        close() {},
        error() {},
      },
    });

    try {
      const stream = await connectEventSocket({
        path,
        watch: ["t"],
        afterCursor: 0,
        hello: { version: "0", mcpContractVersion: 21 },
      });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect((first.value as BatchFrame).cursor).toBe(10);

      // Let the close land while batch 20 sits unread in the queue.
      await Bun.sleep(300);
      let death: unknown;
      try {
        await iterator.next();
      } catch (e) {
        death = e;
      }
      expect(death).toBeInstanceOf(SocketStreamDeath);
      // The documented hazard: the death cursor ran ahead of the consumer.
      expect((death as SocketStreamDeath).lastCursor).toBe(20);
    } finally {
      server.stop();
    }
  });

  test("silence before the first batch is a connect failure, not a stream death", async () => {
    const path = join(root, "sil.sock");
    // Accepts the connection but never sends a byte — not even hello.
    const server = Bun.listen({
      unix: path,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });

    try {
      let caught: unknown;
      try {
        await connectEventSocket({
          path,
          watch: ["t"],
          afterCursor: 0,
          hello: { version: "0", mcpContractVersion: 21 },
          // Short so the test doesn't wait out the real 90s default.
          silenceTimeoutMs: 50,
        });
      } catch (e) {
        caught = e;
      }
      // trySocketRun's initial connect only treats SocketConnectError as a
      // silent-fallback signal; anything else (including SocketStreamDeath)
      // propagates uncaught out of runWatch. A hung pre-hello connection must
      // therefore classify the same way a hard close/error before the first
      // batch already does.
      expect(caught).toBeInstanceOf(SocketConnectError);
    } finally {
      server.stop();
    }
  });
});

// dirname helper
function dirname(p: string): string {
  return p.split("/").slice(0, -1).join("/") || "/";
}
