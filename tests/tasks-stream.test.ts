import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import * as realTaskScope from "../src/task-scope";

// The broker wraps every worker spawn in sandbox-exec, which cannot nest
// inside this sandboxed test runner (the integration suite is gated on
// INTER_SANDBOX_INTEGRATION for the same reason). The discipline under test
// here is the stdout line handler, not the seatbelt, so only the wrapper is
// replaced; the worker itself still runs as a real subprocess.
mock.module("../src/task-scope", () => ({
  ...realTaskScope,
  sandboxedCommand: (command: string[]) => command,
}));

const { delegate, getTask } = await import("../src/tasks");
const { closeStateStore, stateStore } = await import("../src/store");
import type { Profile } from "../src/types";

// A custom command means delegate exercises the real stream loop without
// needing a provider CLI on the machine.
const streamProfile: Profile = {
  id: "noop",
  label: "Noop",
  provider: "antigravity",
  model: "fake",
  enabled: true,
  env: {},
  capabilities: [],
};

describe("stdout line handler", () => {
  const savedRoots = process.env.INTER_ROOTS;
  const savedDb = process.env.INTER_DB;
  const scratch: string[] = [];

  afterEach(() => {
    closeStateStore();
    if (savedRoots === undefined) delete process.env.INTER_ROOTS;
    else process.env.INTER_ROOTS = savedRoots;
    if (savedDb === undefined) delete process.env.INTER_DB;
    else process.env.INTER_DB = savedDb;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // delegate() launches the worker without awaiting it. A test that returns
  // before the run settles leaves `runTask` calling stateStore() after afterEach
  // has closed the store and cleared INTER_DB — which reopens, and migrates, the
  // real broker database.
  async function settled(id: string): Promise<import("../src/types").Task> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const task = getTask(id);
      if (task && !["queued", "running"].includes(task.state)) return task;
      await Bun.sleep(25);
    }
    throw new Error(`task never settled: ${id}`);
  }

  test("a malformed line costs only that line, not the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-lines-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([{
      ...streamProfile,
      // First line is not JSON, last is the completion marker; only the
      // middle line can parse.
      command: ["/bin/sh", "-c", "printf 'not json at all\\n{\"type\":\"hello\"}\\nINTER_RESULT: completed\\n'"],
    }]);

    const task = await delegate("noop", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    // The garbage line did not stop the stream: the well-formed line after
    // it still reached the log, and the run finished normally.
    expect(stateStore().listTaskEvents(task.id).map(({ type }) => type))
      .toContain("agent.hello");
  });

  test("an oversized line is truncated and stored, not silently dropped", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-lines-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([{
      ...streamProfile,
      // A single JSON line whose "big" field is ~100 KB, well over the 64 KB
      // stdout line cap this suite exists to exercise.
      command: [
        "/bin/sh", "-c",
        "big=$(head -c 100000 /dev/zero | tr '\\0' 'a'); " +
          "printf '{\"type\":\"hello\",\"big\":\"%s\"}\\n' \"$big\"; " +
          "printf 'INTER_RESULT: completed\\n'",
      ],
    }]);

    const task = await delegate("noop", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const events = stateStore().listTaskEvents(task.id);
    // The oversized line reached storage under its own event type — it was
    // truncated at write time, never dropped.
    expect(events.map(({ type }) => type)).toContain("agent.hello");
    expect(events.map(({ type }) => type)).not.toContain("event_dropped");
    const stored = events.find(({ type }) => type === "agent.hello")!;
    expect((stored.payload as { big: string }).big.length).toBeLessThan(100_000);
    expect((stored.payload as { big: string }).big).toContain("…[truncated: kept");
  });

  test("a failed event write fails the run loudly instead of vanishing", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-lines-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([{
      ...streamProfile,
      // The child sleeps so the test can sabotage event writes between
      // worker_spawned and the first streamed line.
      command: ["/bin/sh", "-c", "sleep 1.5; printf '{\"type\":\"hello\"}\\n'"],
    }]);

    const task = await delegate("noop", "prompt", root);
    // worker_spawned lands right after spawn, 1.5s before the child's first
    // line; seeing it means the sabotage window is still wide open.
    let spawned = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (stateStore().listTaskEvents(task.id).some(({ type }) => type === "worker_spawned")) {
        spawned = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(spawned).toBe(true);
    // Abort agent event inserts only, from a second connection: the trigger
    // leaves reads — and the failure recording on tasks — working.
    const saboteur = new Database(process.env.INTER_DB!);
    saboteur.query(`
      CREATE TRIGGER fail_event_writes BEFORE INSERT ON task_events
      WHEN NEW.event_type = 'agent.hello'
      BEGIN SELECT RAISE(ABORT, 'test induced event write failure'); END
    `).run();
    saboteur.close();

    const done = await settled(task.id);
    expect(done.state).toBe("failed");
    expect(done.completion?.code).toBe("worker_error");
    expect(done.error).toContain("test induced event write failure");
    // The aborted write left no partial row behind.
    expect(stateStore().listTaskEvents(task.id).map(({ type }) => type))
      .not.toContain("agent.hello");
  });
});
