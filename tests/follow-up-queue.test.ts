import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, closeStateStore, stateStore } from "../src/store";
import { delegate, feedFollowUpQueue, resumeTask } from "../src/tasks";
import { sweepHolds, type HoldSweepDependencies } from "../src/holds";
import type { ProfileStatus } from "../src/profile-status";
import type { Profile, Task, TaskHold, TaskState } from "../src/types";

const roots: string[] = [];
const initialPath = process.env.PATH;

afterEach(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_ROOTS;
  process.env.PATH = initialPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// No `command` of its own, so the broker builds the argv and the session is
// reopenable — which is what a fed follow-up needs. `agy` is shadowed on PATH
// so the resume spawns something that exists and exits.
const resumable: Profile = {
  id: "fake-antigravity",
  label: "Fake Antigravity",
  provider: "antigravity",
  model: "flash",
  enabled: true,
  env: {},
  capabilities: [],
};

function setup(script = "#!/bin/sh\nexit 0\n"): string {
  const root = mkdtempSync(join(tmpdir(), "inter-followup-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "agy"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}:${initialPath}`;
  stateStore().saveProfiles([resumable]);
  return root;
}

function task(cwd: string, state: TaskState, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const row: Task = {
    id: crypto.randomUUID(),
    profileId: resumable.id,
    model: resumable.model,
    prompt: "build the thing",
    cwd,
    state,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    sessionId: "session-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  stateStore().createTask(row);
  return row;
}

function eventTypes(id: string): string[] {
  return stateStore().listTaskEvents(id).map((event) => event.type);
}

function eventPayload(id: string, type: string): Record<string, unknown> | undefined {
  return stateStore().listTaskEvents(id).find((event) => event.type === type)?.payload;
}

/// A fed follow-up launches a worker without awaiting it. Returning before that
/// run lands leaves it writing to a store `afterEach` has already closed.
async function settle(id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = stateStore().getTask(id)?.state;
    if (state && !["queued", "running"].includes(state)) return;
    await Bun.sleep(25);
  }
  throw new Error(`task never settled: ${id}`);
}

describe("queueing a follow-up", () => {
  test("a resume on a running task waits instead of being refused", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    const queued = await resumeTask(row.id, "then write the tests", { queue: "add" });
    expect(queued.state).toBe("running");
    expect(queued.queuedFollowUps).toBe(1);
    expect(eventTypes(row.id)).toContain("follow_up_queued");
    expect(eventPayload(row.id, "follow_up_queued")?.instruction).toBe("then write the tests");
  });

  test("queued and waiting tasks take follow-ups too", async () => {
    const cwd = setup();
    for (const state of ["queued", "pending"] as const) {
      const row = task(cwd, state);
      await resumeTask(row.id, "next", { queue: "add" });
      expect(stateStore().countFollowUps(row.id)).toBe(1);
    }
  });

  test("a task waiting on a question does not take one", async () => {
    const cwd = setup();
    const row = task(cwd, "needs_input", { question: "which folder?" });
    await expect(resumeTask(row.id, "next", { queue: "add" }))
      .rejects.toThrow("task cannot be resumed from state needs_input");
    expect(stateStore().countFollowUps(row.id)).toBe(0);
  });

  test("an empty follow-up is refused", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await expect(resumeTask(row.id, "   ", { queue: "add" }))
      .rejects.toThrow("needs an instruction");
    await expect(resumeTask(row.id, undefined, { queue: "add" }))
      .rejects.toThrow("needs an instruction");
    expect(stateStore().countFollowUps(row.id)).toBe(0);
  });

  test("run settings cannot ride on a queued instruction", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await expect(resumeTask(row.id, "next", { queue: "add", timeoutMs: 1000 }))
      .rejects.toThrow("takes only an instruction");
    expect(stateStore().countFollowUps(row.id)).toBe(0);
  });

  test("on a finished task the flag is inert and the resume runs now", async () => {
    const cwd = setup();
    const row = task(cwd, "completed");
    await resumeTask(row.id, "one more thing", { queue: "add" });
    expect(stateStore().getTask(row.id)?.state).not.toBe("completed");
    expect(eventPayload(row.id, "resumed")?.instruction).toBe("one more thing");
    expect(stateStore().countFollowUps(row.id)).toBe(0);
    expect(eventTypes(row.id)).not.toContain("follow_up_queued");
    await settle(row.id);
  });
});

describe("feeding the queue", () => {
  test("a clean landing feeds the oldest instruction back into the session", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await resumeTask(row.id, "first", { queue: "add" });
    await resumeTask(row.id, "second", { queue: "add" });
    const completed = { ...row, state: "completed" as const };
    stateStore().saveTask(completed, "completed", {});

    await feedFollowUpQueue(completed);

    expect(eventPayload(row.id, "follow_up_started")?.instruction).toBe("first");
    // The resume ran on the same row: `completed` is behind it now.
    expect(stateStore().getTask(row.id)?.state).not.toBe("completed");
    expect(eventPayload(row.id, "resumed")?.instruction).toBe("first");
    // FIFO — the untouched half of the queue still starts with "second".
    expect(stateStore().countFollowUps(row.id)).toBe(1);
    expect(stateStore().takeNextFollowUp(row.id)).toBe("second");
    await settle(row.id);
  });

  test("a real run reaching the end of its life consults the queue by itself", async () => {
    // The worker lingers long enough to queue behind it, then exits without
    // attesting anything, so the run lands badly and the queue must hold.
    const cwd = setup("#!/bin/sh\nsleep 0.4\nexit 0\n");
    const started = await delegate(resumable.id, "build the thing", cwd);
    for (let attempt = 0; attempt < 100 && stateStore().getTask(started.id)?.state !== "running"; attempt++) {
      await Bun.sleep(10);
    }
    await resumeTask(started.id, "then write the tests", { queue: "add" });

    await settle(started.id);
    // Nothing in this test called the feed; only the settle path could have.
    for (let attempt = 0; attempt < 100 && !eventTypes(started.id).includes("follow_ups_paused"); attempt++) {
      await Bun.sleep(10);
    }
    expect(eventTypes(started.id)).toContain("follow_ups_paused");
    expect(stateStore().countFollowUps(started.id)).toBe(1);
  });

  test("nothing waiting means no resume", async () => {
    const cwd = setup();
    const row = task(cwd, "completed");
    await feedFollowUpQueue(row);
    expect(stateStore().getTask(row.id)?.state).toBe("completed");
    expect(eventTypes(row.id)).not.toContain("follow_up_started");
  });
});

describe("what a bad landing does to the queue", () => {
  for (const state of ["failed", "blocked", "needs_input"] as const) {
    test(`a run that ends ${state} keeps its follow-ups and says so`, async () => {
      const cwd = setup();
      const row = task(cwd, "running");
      await resumeTask(row.id, "first", { queue: "add" });
      const landed = { ...row, state };
      stateStore().saveTask(landed, state, {});

      await feedFollowUpQueue(landed);

      expect(stateStore().countFollowUps(row.id)).toBe(1);
      expect(eventTypes(row.id)).not.toContain("follow_up_started");
      expect(eventPayload(row.id, "follow_ups_paused")?.waiting).toBe(1);
    });
  }

  test("a cancelled run drops them", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await resumeTask(row.id, "first", { queue: "add" });
    const landed = { ...row, state: "cancelled" as const };
    stateStore().saveTask(landed, "cancelled", {});

    await feedFollowUpQueue(landed);

    expect(stateStore().countFollowUps(row.id)).toBe(0);
    expect(eventPayload(row.id, "follow_ups_dropped")?.dropped).toBe(1);
  });

  test("a clean landing on an empty queue says nothing at all", async () => {
    const cwd = setup();
    const row = task(cwd, "failed");
    await feedFollowUpQueue(row);
    expect(eventTypes(row.id)).not.toContain("follow_ups_paused");
  });
});

describe("removing and dropping", () => {
  test("the caller can clear what is still waiting", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await resumeTask(row.id, "first", { queue: "add" });
    await resumeTask(row.id, "second", { queue: "add" });

    const cleared = await resumeTask(row.id, undefined, { queue: "clear" });

    expect(cleared.state).toBe("running");
    expect(cleared.queuedFollowUps).toBeUndefined();
    expect(stateStore().countFollowUps(row.id)).toBe(0);
    expect(eventPayload(row.id, "follow_ups_dropped")?.dropped).toBe(2);
    expect(eventPayload(row.id, "follow_ups_dropped")?.reason).toBe("removed on request");
  });

  test("cancelling the task drops its queue, the way it drops its hold", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await resumeTask(row.id, "first", { queue: "add" });

    stateStore().cancelTask(row.id, "no longer wanted", {
      blocked: true, code: "cancelled", reason: "no longer wanted",
    });

    expect(stateStore().countFollowUps(row.id)).toBe(0);
    expect(eventPayload(row.id, "follow_ups_dropped")?.dropped).toBe(1);
  });
});

describe("durability", () => {
  test("the queue survives a broker restart, in order", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-followup-"));
    roots.push(root);
    const db = join(root, "inter.db");
    const first = new StateStore({ path: db, seedProfiles: [resumable] });
    const now = new Date().toISOString();
    const row: Task = {
      id: crypto.randomUUID(),
      profileId: resumable.id,
      model: resumable.model,
      prompt: "build",
      cwd: root,
      state: "running",
      output: "",
      scope: { read: ["**"], write: ["**"] },
      allowQuestions: true,
      createdAt: now,
      updatedAt: now,
    };
    first.createTask(row);
    first.queueFollowUp(row.id, "running", "first");
    first.queueFollowUp(row.id, "running", "second");
    first.close();

    const reopened = new StateStore({ path: db });
    expect(reopened.countFollowUps(row.id)).toBe(2);
    expect(reopened.takeNextFollowUp(row.id)).toBe("first");
    expect(reopened.takeNextFollowUp(row.id)).toBe("second");
    expect(reopened.takeNextFollowUp(row.id)).toBeUndefined();
    reopened.close();
  });
});

describe("a hold and a queue on the same task", () => {
  function status(state: ProfileStatus["state"]): ProfileStatus {
    return {
      profile: resumable.id,
      provider: "antigravity",
      model: resumable.model,
      state,
      source: "task",
      reason: "past its retry time",
      checkedAt: new Date().toISOString(),
    };
  }

  function hold(taskId: string): TaskHold {
    const now = new Date();
    return {
      taskId,
      verb: "resume",
      args: {},
      startAt: now.toISOString(),
      awaitProfile: resumable.id,
      awaitModel: resumable.model,
      nextCheckAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      probeCount: 0,
      note: "waiting for usage again",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  test("a rate-limited run keeps its queue through the hold, and feeds it after", async () => {
    const cwd = setup();
    const row = task(cwd, "running");
    await resumeTask(row.id, "first", { queue: "add" });
    await resumeTask(row.id, "second", { queue: "add" });

    // The run dies on the rate limit. The queue must not feed into it.
    const failed = { ...row, state: "failed" as const };
    stateStore().saveTask(failed, "failed", {});
    await feedFollowUpQueue(failed);
    expect(stateStore().countFollowUps(row.id)).toBe(2);

    // Parked behind a hold until the account has usage again.
    stateStore().armTaskHold(hold(row.id));
    expect(stateStore().getTask(row.id)?.state).toBe("pending");
    expect(stateStore().countFollowUps(row.id)).toBe(2);

    const released: string[] = [];
    const deps: HoldSweepDependencies = {
      listStatuses: async () => [status("unknown")],
      release: async (taskId) => { released.push(taskId); },
      now: () => new Date(),
      log: () => {},
    };
    await sweepHolds(stateStore(), deps);
    expect(released).toEqual([row.id]);
    expect(stateStore().countFollowUps(row.id)).toBe(2);

    // The revived run lands clean, and the queue picks up where it left off.
    const completed = { ...row, state: "completed" as const };
    stateStore().saveTask(completed, "completed", {});
    await feedFollowUpQueue(completed);
    expect(eventPayload(row.id, "follow_up_started")?.instruction).toBe("first");
    expect(stateStore().countFollowUps(row.id)).toBe(1);
    await settle(row.id);
  });
});
