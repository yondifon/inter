import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import { startEventSocket, type EventSocketHandle } from "../src/event-socket";
import type { Task, TaskState } from "../src/types";

/**
 * The three transport stories of `inter watch`, proven at the outermost seam:
 * the real CLI as a subprocess, reading real stdout and real exit codes. The
 * in-process tests in watch.test.ts share the test's own store singleton, so
 * only a subprocess can prove the story that matters most — that socket mode
 * never opens the database at all.
 *
 * The broker side runs in-process (`startEventSocket` against the scratch
 * store) rather than as a second subprocess: the socket server is the entire
 * broker surface watch talks to, and an in-process handle is what lets the
 * failover story kill it at an exact moment.
 */

let root: string;
let dbPath: string;
let sockPath: string;
let server: EventSocketHandle | undefined;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function seedTask(state: TaskState, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: "sock-fake",
    model: "fake",
    prompt: "seed",
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

function seedEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
  stateStore().appendTaskEvent(taskId, type, "running", payload);
}

function finish(task: Task): void {
  stateStore().saveTask({ ...task, state: "completed", updatedAt: new Date().toISOString() }, "completed");
}

interface WatchProcess {
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number>;
  kill: () => void;
  /** Polls until the predicate holds over accumulated stdout+stderr. */
  waitFor: (predicate: (stdout: string, stderr: string) => boolean, timeoutMs?: number) => Promise<void>;
}

const children = new Set<ReturnType<typeof Bun.spawn>>();

/**
 * Spawns the real CLI and reads its streams incrementally, so a test can react
 * to output while the process still runs — the failover story needs to kill
 * the server at a moment it can only recognise from stdout.
 */
function spawnWatch(taskId: string, env: Record<string, string | undefined>): WatchProcess {
  const child = Bun.spawn(["bun", "run", CLI, "watch", taskId, "--timeout", "20s"], {
    env: { ...process.env, INTER_PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  let out = "";
  let err = "";
  void (async () => {
    for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk);
  })();
  void (async () => {
    for await (const chunk of child.stderr) err += new TextDecoder().decode(chunk);
  })();
  return {
    stdout: () => out,
    stderr: () => err,
    exited: child.exited,
    kill: () => child.kill(),
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(out, err)) return;
        await Bun.sleep(50);
      }
      throw new Error(`waitFor timed out\nstdout:\n${out}\nstderr:\n${err}`);
    },
  };
}

/**
 * Events emitted before the watcher subscribes are history and stay unprinted,
 * so every story must first prove attachment. Probes are emitted until one
 * shows up on stdout; assertions then run on events emitted exactly once after
 * that, which is what keeps the exactly-once checks meaningful.
 */
async function proveAttached(watch: WatchProcess, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seedEvent(taskId, "worker_spawned", { provider: `probe-${attempt}` });
    try {
      await watch.waitFor((out) => out.includes("Worker spawned: probe-"), 250);
      return;
    } catch {
      // Not attached yet; try again.
    }
  }
  throw new Error("watch never attached");
}

function countOf(haystack: string, needle: string): number {
  return haystack.split("\n").filter((line) => line === needle).length;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "inter-ws-"));
  dbPath = join(root, "inter.db");
  sockPath = join(root, "s.sock");
  process.env.INTER_DB = dbPath;
  stateStore().saveProfiles([{
    id: "sock-fake",
    label: "Sock Fake",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
  }]);
});

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
  server?.stop();
  server = undefined;
});

afterAll(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  rmSync(root, { recursive: true, force: true });
});

describe("watch over the event socket, end to end", () => {
  test("AC-001: socket mode streams and settles with no database at all", async () => {
    server = startEventSocket({
      path: sockPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 21 },
      keepaliveMs: 1_000,
    });
    const task = seedTask("running");

    // The subprocess's INTER_DB points at a path that cannot even be observed:
    // any store open in socket mode would exit 2 with `cannot observe`, and the
    // assertions below would fail on code and stderr both.
    const watch = spawnWatch(task.id, {
      INTER_DB: join(root, "nonexistent", "inter.db"),
      INTER_SOCK: sockPath,
    });
    await proveAttached(watch, task.id);

    seedEvent(task.id, "worker_spawned", { provider: "the-real-one" });
    await watch.waitFor((out) => out.includes("Worker spawned: the-real-one"));
    finish(task);

    const code = await watch.exited;
    expect(code).toBe(0);
    expect(watch.stdout()).toContain(`${task.id} completed`);
    expect(watch.stderr()).toBe("");
  }, 30_000);

  test("AC-002: no socket bound falls back to the database silently", async () => {
    const task = seedTask("running");

    // INTER_SOCK names a path nothing listens on: the fallback must be silent
    // and complete — same lines, exit 0, empty stderr.
    const watch = spawnWatch(task.id, { INTER_DB: dbPath, INTER_SOCK: sockPath });
    await proveAttached(watch, task.id);

    seedEvent(task.id, "worker_spawned", { provider: "db-only" });
    await watch.waitFor((out) => out.includes("Worker spawned: db-only"));
    finish(task);

    const code = await watch.exited;
    expect(code).toBe(0);
    expect(countOf(watch.stdout(), "Worker spawned: db-only")).toBe(1);
    expect(watch.stdout()).toContain(`${task.id} completed`);
    expect(watch.stderr()).toBe("");
  }, 30_000);

  test("AC-003: killing the server mid-run fails over with every line exactly once", async () => {
    server = startEventSocket({
      path: sockPath,
      hello: { version: "0.0.0-test", mcpContractVersion: 21 },
      keepaliveMs: 1_000,
    });
    const task = seedTask("running");

    const watch = spawnWatch(task.id, { INTER_DB: dbPath, INTER_SOCK: sockPath });
    await proveAttached(watch, task.id);

    // One event over the socket, confirmed on stdout before the kill, so the
    // failover provably happens between two printed events.
    seedEvent(task.id, "worker_spawned", { provider: "before-failover" });
    await watch.waitFor((out) => out.includes("Worker spawned: before-failover"));

    server.stop();
    server = undefined;
    await watch.waitFor((_out, err) => err.includes("event socket lost"));

    // The rest arrives through the database.
    seedEvent(task.id, "worker_spawned", { provider: "after-failover" });
    await watch.waitFor((out) => out.includes("Worker spawned: after-failover"));
    finish(task);

    const code = await watch.exited;
    expect(code).toBe(0);
    const out = watch.stdout();
    expect(countOf(out, "Worker spawned: before-failover")).toBe(1);
    expect(countOf(out, "Worker spawned: after-failover")).toBe(1);
    expect(out).toContain(`${task.id} completed`);
    // Exactly one warning; the fallback itself is otherwise quiet.
    const warnings = watch.stderr().split("\n").filter((line) => line.includes("event socket lost"));
    expect(warnings.length).toBe(1);
  }, 30_000);
});
