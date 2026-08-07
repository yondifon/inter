import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store";
import { resolveStartAt, sweepHolds, type HoldSweepDependencies } from "../src/holds";
import type { Profile, Task, TaskHold } from "../src/types";
import type { ProfileStatus } from "../src/profile-status";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "claude-work",
  label: "Claude work",
  provider: "claude",
  model: "opus",
  enabled: true,
  env: {},
  capabilities: ["build"],
};

function openStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "inter-holds-"));
  roots.push(root);
  return new StateStore({ path: join(root, "inter.db"), seedProfiles: [profile] });
}

function failedTask(): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId: profile.id,
    model: "opus",
    prompt: "build",
    cwd: "/tmp/project",
    state: "failed",
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
  };
}

function hold(taskId: string, overrides: Partial<TaskHold> = {}): TaskHold {
  const now = new Date();
  return {
    taskId,
    verb: "resume",
    args: { instruction: "continue" },
    startAt: now.toISOString(),
    awaitProfile: profile.id,
    awaitModel: "opus",
    nextCheckAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    probeCount: 0,
    note: "waiting for claude-work/opus to have usage again",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function status(state: ProfileStatus["state"], retryAt?: string): ProfileStatus {
  return {
    profile: profile.id,
    provider: "claude",
    model: "opus",
    state,
    source: "task",
    reason: state === "unavailable" ? "Observed rate limit" : "past its retry time",
    checkedAt: new Date().toISOString(),
    ...(retryAt ? { retryAt } : {}),
  };
}

function deps(
  statuses: ProfileStatus[],
  released: Array<{ taskId: string; instruction?: string }>,
): HoldSweepDependencies {
  return {
    listStatuses: async () => statuses,
    release: async (taskId, instruction) => {
      released.push({ taskId, ...(instruction ? { instruction } : {}) });
    },
    now: () => new Date(),
    log: () => {},
  };
}

describe("task holds", () => {
  test("arming parks the task as pending and cancel drops the hold", () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    const held = store.armTaskHold(hold(row.id));
    expect(held.state).toBe("pending");
    expect(store.getTaskHold(row.id)?.note).toContain("claude-work");
    expect(store.cancelTask(row.id, "no longer wanted", {
      blocked: false, code: "cancelled", reason: "no longer wanted",
    })?.state).toBe("cancelled");
    expect(store.getTaskHold(row.id)).toBeUndefined();
  });

  test("a pending task survives a store reopen untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-holds-"));
    roots.push(root);
    const db = join(root, "inter.db");
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const row = failedTask();
    first.createTask(row);
    first.armTaskHold(hold(row.id));
    first.close();
    const reopened = new StateStore({ path: db });
    expect(reopened.getTask(row.id)?.state).toBe("pending");
    expect(reopened.getTaskHold(row.id)).toBeDefined();
  });

  test("the sweep releases a due hold once the account is no longer unavailable", async () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    store.armTaskHold(hold(row.id));
    const released: Array<{ taskId: string; instruction?: string }> = [];
    await sweepHolds(store, deps([status("unknown")], released));
    expect(released).toEqual([{ taskId: row.id, instruction: "continue" }]);
    expect(store.getTaskHold(row.id)).toBeUndefined();
  });

  test("the sweep re-arms from the fresh retry time while the account is still down", async () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    store.armTaskHold(hold(row.id));
    const released: Array<{ taskId: string; instruction?: string }> = [];
    const retryAt = new Date(Date.now() + 20 * 60_000).toISOString();
    await sweepHolds(store, deps([status("unavailable", retryAt)], released));
    expect(released).toEqual([]);
    const parked = store.getTaskHold(row.id);
    expect(parked).toBeDefined();
    expect(Date.parse(parked!.nextCheckAt)).toBeGreaterThan(Date.now() + 60_000);
  });

  test("an expired hold lands the task blocked instead of vanishing", async () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    store.armTaskHold(hold(row.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const released: Array<{ taskId: string; instruction?: string }> = [];
    await sweepHolds(store, deps([status("unknown")], released));
    expect(released).toEqual([]);
    const after = store.getTask(row.id);
    expect(after?.state).toBe("blocked");
    expect(after?.completion?.reason).toContain("without its start condition");
    expect(store.getTaskHold(row.id)).toBeUndefined();
  });

  test("a hold on a task that already moved on is dropped without a release", async () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    store.armTaskHold(hold(row.id));
    store.resumeTask(row.id, {});
    const released: Array<{ taskId: string; instruction?: string }> = [];
    await sweepHolds(store, deps([status("unknown")], released));
    expect(released).toEqual([]);
    expect(store.getTaskHold(row.id)).toBeUndefined();
  });

  test("a clock hold waits for its start time", async () => {
    const store = openStore();
    const row = failedTask();
    store.createTask(row);
    const startAt = new Date(Date.now() + 3_600_000 / 2).toISOString();
    store.armTaskHold(hold(row.id, {
      startAt,
      nextCheckAt: new Date().toISOString(),
      awaitProfile: undefined,
      awaitModel: undefined,
    }));
    const released: Array<{ taskId: string; instruction?: string }> = [];
    await sweepHolds(store, deps([], released));
    expect(released).toEqual([]);
    expect(store.getTaskHold(row.id)?.nextCheckAt).toBe(startAt);
  });
});

describe("resolveStartAt", () => {
  test("durations and ISO instants resolve; junk is refused", () => {
    const now = new Date("2026-08-07T12:00:00Z");
    expect(resolveStartAt("45m", now)).toBe("2026-08-07T12:45:00.000Z");
    expect(resolveStartAt("4h", now)).toBe("2026-08-07T16:00:00.000Z");
    expect(resolveStartAt("2026-08-08T03:00:00Z", now)).toBe("2026-08-08T03:00:00.000Z");
    expect(() => resolveStartAt("tomorrow", now)).toThrow("startAt must be");
  });
});
