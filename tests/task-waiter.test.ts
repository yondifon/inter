import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store";
import { TaskWaiter } from "../src/task-waiter";
import type { Profile, Task } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "worker",
  label: "Worker",
  provider: "claude",
  model: "sonnet",
  enabled: true,
  env: {},
  capabilities: [],
};

function stores() {
  const root = mkdtempSync(join(tmpdir(), "inter-waiter-"));
  roots.push(root);
  const path = join(root, "inter.db");
  const options = { path, seedProfiles: [profile] };
  return {
    reader: new StateStore(options),
    writer: new StateStore(options),
    options,
  };
}

function storeWaiter(store: StateStore): TaskWaiter {
  return new TaskWaiter(
    (id) => store.getTask(id),
    (ids) => store.latestTaskEventId(ids, true),
  );
}

function task(id: string, state: Task["state"] = "running"): Task {
  const now = new Date().toISOString();
  return {
    id,
    profileId: profile.id,
    model: "sonnet",
    prompt: "work",
    cwd: "/tmp/project",
    state,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("TaskWaiter", () => {
  test("returns terminal work immediately", async () => {
    const tasks = new Map([["done", task("done", "completed")]]);
    const waiter = new TaskWaiter((id) => tasks.get(id));

    expect(await waiter.wait(["done"], 100)).toEqual({
      reason: "attention",
      tasks: [tasks.get("done")!],
      cursor: 0,
    });
  });

  test("wakes concurrent waiters when one tracked task needs attention", async () => {
    const running = task("work");
    const other = task("other");
    const tasks = new Map([["work", running], ["other", other]]);
    const waiter = new TaskWaiter((id) => tasks.get(id));
    const first = waiter.wait(["work", "other"], 100);
    const second = waiter.wait(["work"], 100);

    waiter.notify("unrelated");
    running.state = "needs_input";
    running.question = "Which config?";
    waiter.notify("work");

    expect((await first).reason).toBe("attention");
    expect((await first).tasks.map(({ id }) => id)).toEqual(["work", "other"]);
    expect((await second).tasks[0]?.question).toBe("Which config?");
  });

  test("returns current snapshots on timeout", async () => {
    const running = task("work");
    const waiter = new TaskWaiter((id) => id === running.id ? running : undefined);

    expect(await waiter.wait(["work"], 1)).toEqual({
      reason: "timeout",
      tasks: [running],
      cursor: 0,
    });
  });

  test("wakes on progress newer than the caller cursor", async () => {
    const running = task("work");
    let cursor = 4;
    const waiter = new TaskWaiter(
      (id) => id === running.id ? running : undefined,
      () => cursor,
    );
    const waiting = waiter.wait(["work"], 100, undefined, cursor);

    cursor = 5;
    waiter.notify("work");

    expect(await waiting).toEqual({
      reason: "progress",
      tasks: [running],
      cursor: 5,
    });
  });

  test("rejects unknown task IDs", async () => {
    const waiter = new TaskWaiter(() => undefined);
    await expect(waiter.wait(["missing"], 100)).rejects.toThrow("unknown task: missing");
  });

  test("detects external completed and failed updates within two seconds", async () => {
    const { reader, writer } = stores();
    try {
      for (const state of ["completed", "failed"] as const) {
        const work = task(state === "completed" ? "done" : "broken");
        writer.createTask(work);
        const afterCursor = writer.latestTaskEventId([work.id]);
        const waiting = storeWaiter(reader).wait([work.id], 2_500, undefined, afterCursor);

        const startedAt = performance.now();
        work.state = state;
        if (state === "failed") work.error = "exit 1";
        work.updatedAt = new Date().toISOString();
        writer.saveTask(work, state);

        const result = await waiting;
        expect(result.reason).toBe("attention");
        expect(result.tasks[0]?.state).toBe(state);
        expect(result.cursor).toBeGreaterThan(afterCursor);
        expect(performance.now() - startedAt).toBeLessThan(2_000);
      }
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("does not wake on a heartbeat, but does on a real agent event", async () => {
    const { reader, writer } = stores();
    try {
      const work = task("heartbeat");
      writer.createTask(work);
      const afterCursor = writer.latestTaskEventId([work.id], true);

      // A heartbeat every 10s must not read as news, or a long task bills the
      // caller a wake-up on a fixed timer for as long as it runs.
      const quiet = storeWaiter(reader).wait([work.id], 300, undefined, afterCursor);
      writer.appendTaskEvent(work.id, "heartbeat", work.state, { elapsedMs: 10_000 });
      const idle = await quiet;
      expect(idle.reason).toBe("timeout");
      expect(idle.cursor).toBe(afterCursor);

      const waiting = storeWaiter(reader).wait([work.id], 2_000, undefined, afterCursor);
      writer.appendTaskEvent(work.id, "agent.assistant", work.state, { text: "working" });
      const result = await waiting;
      expect(result.reason).toBe("progress");
      expect(result.tasks[0]?.state).toBe("running");
      expect(result.cursor).toBeGreaterThan(afterCursor);
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("sleeps through progress when until is attention", async () => {
    const { reader, writer } = stores();
    try {
      const work = task("quiet");
      writer.createTask(work);
      const afterCursor = writer.latestTaskEventId([work.id]);

      writer.appendTaskEvent(work.id, "heartbeat", work.state, { elapsedMs: 10_000 });
      const timedOut = await storeWaiter(reader).wait([work.id], 300, undefined, afterCursor, "attention");
      expect(timedOut.reason).toBe("timeout");

      const waiting = storeWaiter(reader).wait([work.id], 2_000, undefined, afterCursor, "attention");
      writer.appendTaskEvent(work.id, "heartbeat", work.state, { elapsedMs: 20_000 });
      work.state = "completed";
      work.updatedAt = new Date().toISOString();
      writer.saveTask(work, "completed");

      const result = await waiting;
      expect(result.reason).toBe("attention");
      expect(result.tasks[0]?.state).toBe("completed");
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("returns a captured provider session id as progress", async () => {
    const { reader, writer } = stores();
    try {
      const work = task("session");
      writer.createTask(work);
      const afterCursor = writer.latestTaskEventId([work.id], true);
      const waiting = storeWaiter(reader).wait([work.id], 2_000, undefined, afterCursor);

      writer.captureTaskSessionId(work.id, profile.provider, "provider-session");

      const result = await waiting;
      expect(result.reason).toBe("progress");
      expect(result.tasks[0]?.sessionId).toBe("provider-session");
      expect(result.cursor).toBeGreaterThan(afterCursor);
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("does not wake on provider system noise", async () => {
    const { reader, writer } = stores();
    try {
      const work = task("noise");
      writer.createTask(work);
      const afterCursor = writer.latestTaskEventId([work.id], true);
      const waiting = storeWaiter(reader).wait([work.id], 30, undefined, afterCursor);
      writer.appendTaskEvent(work.id, "agent.system", work.state, { estimated_tokens_delta: 50 });
      expect((await waiting).reason).toBe("timeout");
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("answered parents stop requesting attention", async () => {
    const answered = task("answered", "answered");
    const waiter = new TaskWaiter((id) => id === answered.id ? answered : undefined);
    expect((await waiter.wait([answered.id], 1)).reason).toBe("timeout");
  });

  test("detects restart recovery from another store", async () => {
    const { reader, writer, options } = stores();
    let restarted: StateStore | undefined;
    try {
      const work = task("restarted");
      writer.createTask(work);
      const afterCursor = writer.latestTaskEventId([work.id]);
      const waiting = storeWaiter(reader).wait([work.id], 2_000, undefined, afterCursor);

      writer.close();
      restarted = new StateStore(options);

      const result = await waiting;
      expect(result.reason).toBe("attention");
      expect(result.tasks[0]?.state).toBe("failed");
      expect(result.tasks[0]?.error).toBe("Broker restarted before task completed");
      expect(result.cursor).toBeGreaterThan(afterCursor);
      expect(restarted.listTaskEvents(work.id).at(-1)?.type).toBe("broker_restarted");
    } finally {
      reader.close();
      restarted?.close();
    }
  });
});
