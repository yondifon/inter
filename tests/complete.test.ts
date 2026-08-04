import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertTaskCompletion } from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile, Task } from "../src/types";

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

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "inter-complete-"));
  scratch.push(dir);
  process.env.INTER_DB = join(dir, "inter.db");
  // The task layer only touches the store; no provider runs, so a single root
  // that is also the task cwd is enough. The profile must exist: tasks rows
  // carry a foreign key onto profiles.
  process.env.INTER_ROOTS = dir;
  const noop: Profile = {
    id: "noop",
    label: "Noop",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
    command: ["true"],
  };
  stateStore().saveProfiles([noop]);
  return dir;
}

function task(state: Task["state"], completion?: Task["completion"]): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId: "noop",
    model: "fake",
    prompt: "build the feature",
    cwd: homedir(),
    state,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
    ...(completion ? { completion } : {}),
  };
}

describe("assertTaskCompletion", () => {
  test("completes a blocked task and keeps the unverified completion on the record", async () => {
    const root = freshDb();
    const unverified = task("blocked", {
      blocked: true,
      code: "unverified",
      reason: "worker exited without an Inter completion marker",
    });
    stateStore().createTask(unverified);

    const done = await assertTaskCompletion(unverified.id, "alice", "feature verified by hand; 416 tests pass");

    expect(done.state).toBe("completed");
    // The signal that this is an assertion, not an attestation: the original
    // completion survives verbatim, and the override explains the correction.
    expect(done.completion).toMatchObject({
      blocked: true,
      code: "unverified",
      reason: "worker exited without an Inter completion marker",
      assertedCompletion: {
        assertedBy: "alice",
        reason: "feature verified by hand; 416 tests pass",
        replacedCode: "unverified",
      },
    });
    expect(done.completion!.assertedCompletion!.assertedAt).toBeString();
  });

  test("accepts a failed task and records the code it replaced", async () => {
    const root = freshDb();
    const failed = task("failed", {
      exitCode: 1,
      blocked: true,
      code: "worker_error",
      reason: "exit 1",
    });
    stateStore().createTask(failed);

    const done = await assertTaskCompletion(failed.id, "ci", "all build artifacts present on disk");

    expect(done.state).toBe("completed");
    expect(done.completion!.assertedCompletion!.replacedCode).toBe("worker_error");
    expect(done.completion!.code).toBe("worker_error");
  });

  test("requires a non-empty reason", async () => {
    const root = freshDb();
    const blocked = task("blocked", { blocked: true, code: "unverified" });
    stateStore().createTask(blocked);

    await expect(assertTaskCompletion(blocked.id, "alice", ""))
      .rejects.toThrow(`asserted completion needs a reason: ${blocked.id}`);
    await expect(assertTaskCompletion(blocked.id, "alice", "   "))
      .rejects.toThrow(`asserted completion needs a reason: ${blocked.id}`);
    expect(stateStore().getTask(blocked.id)?.state).toBe("blocked");
  });

  test("requires who asserted it", async () => {
    const root = freshDb();
    const blocked = task("blocked", { blocked: true, code: "unverified" });
    stateStore().createTask(blocked);

    await expect(assertTaskCompletion(blocked.id, "", "it landed"))
      .rejects.toThrow(`asserted completion needs who asserted it: ${blocked.id}`);
    expect(stateStore().getTask(blocked.id)?.state).toBe("blocked");
  });

  test("rejects a running task — completion of work in flight is a worse mistake", async () => {
    const root = freshDb();
    const running = task("running");
    stateStore().createTask(running);

    await expect(assertTaskCompletion(running.id, "alice", "looks done"))
      .rejects.toThrow(`task is still running: ${running.id}`);
    expect(stateStore().getTask(running.id)?.state).toBe("running");
  });

  test("rejects an already completed task without touching its record", async () => {
    const root = freshDb();
    const verified = task("completed", { blocked: false, code: "completed" });
    stateStore().createTask(verified);

    await expect(assertTaskCompletion(verified.id, "alice", "still fine"))
      .rejects.toThrow(`task is already completed: ${verified.id}`);
    const current = stateStore().getTask(verified.id)!;
    expect(current.state).toBe("completed");
    expect(current.completion?.assertedCompletion).toBeUndefined();
  });

  test("rejects a task the caller cancelled", async () => {
    const root = freshDb();
    const cancelled = task("cancelled", {
      blocked: true,
      code: "cancelled",
      reason: "cancelled by caller",
    });
    stateStore().createTask(cancelled);

    await expect(assertTaskCompletion(cancelled.id, "alice", "work landed anyway"))
      .rejects.toThrow(`task was cancelled: ${cancelled.id}`);
    expect(stateStore().getTask(cancelled.id)?.state).toBe("cancelled");
  });

  test("rejects states that are neither blocked nor failed", async () => {
    const root = freshDb();
    for (const state of ["queued", "needs_input", "answered"] as const) {
      const parked = task(state);
      stateStore().createTask(parked);
      await expect(assertTaskCompletion(parked.id, "alice", "it landed"))
        .rejects.toThrow(`task cannot be asserted completed from state ${state}: ${parked.id}`);
    }
  });

  test("emits a completion_asserted event with the override in the trace", async () => {
    const root = freshDb();
    const blocked = task("blocked", {
      blocked: true,
      code: "unverified",
      reason: "worker exited without an Inter completion marker",
    });
    stateStore().createTask(blocked);

    await assertTaskCompletion(blocked.id, "alice", "checked by hand");

    const event = stateStore().listTaskEvents(blocked.id).at(-1);
    expect(event).toMatchObject({
      type: "completion_asserted",
      state: "completed",
      payload: {
        assertedBy: "alice",
        reason: "checked by hand",
        replacedCode: "unverified",
        previousState: "blocked",
      },
    });
  });
});
