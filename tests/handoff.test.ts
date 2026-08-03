import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTask, handoffTask, resumeTask, scopeInheritanceWarning } from "../src/tasks";
import { interpretWorkerOutcome } from "../src/task-protocol";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile, Task } from "../src/types";

const PROMPT = "# Goal\nReview src/store.ts and write the findings to docs/reviews/store.md.";
// Verbatim from the 2026-08-03 incident.
const SESSION_LIMIT = "You've hit your session limit · resets 12:40am (Africa/Douala)";

// A custom command keeps the destination worker off a real provider CLI. The
// spawn itself is not what these tests are about: `runTask` records the shipped
// prompt before it spawns, so the brief is on the row either way, and the live
// two-worker path is covered in task-lifecycle.integration.test.ts.
function worker(id: string): Profile {
  return {
    id,
    label: id,
    provider: "claude",
    model: `${id}-model`,
    enabled: true,
    env: {},
    capabilities: [],
    command: ["true"],
  };
}

const scratch: string[] = [];
const savedDb = process.env.INTER_DB;
const savedRoots = process.env.INTER_ROOTS;

afterEach(() => {
  closeStateStore();
  if (savedDb === undefined) delete process.env.INTER_DB;
  else process.env.INTER_DB = savedDb;
  if (savedRoots === undefined) delete process.env.INTER_ROOTS;
  else process.env.INTER_ROOTS = savedRoots;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-handoff-"));
  scratch.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  stateStore().saveProfiles([worker("alpha"), worker("beta")]);
  return root;
}

/**
 * The reference incident as a stored task: a worker on `alpha` that read a file,
 * reached a finding, started writing the deliverable, and was cut off by the
 * account's session limit. The failure is interpreted by the real classifier, so
 * the rate-limit code and the reset time are produced, not asserted into place.
 */
function deadOnAlpha(root: string): Task {
  const store = stateStore();
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: "alpha",
    model: "alpha-model",
    prompt: PROMPT,
    cwd: root,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: ["src/**"], write: ["docs/reviews/**"] },
    allowQuestions: true,
    title: "Review the store",
  };
  store.createTask(task);
  store.captureTaskSessionId(task.id, "claude", "sess-alpha");
  for (const content of [
    [{ type: "tool_use", name: "Read", input: { file_path: "src/store.ts" } }],
    [{ type: "text", text: "Finding: listTaskEvents drops the last row." }],
    [{ type: "tool_use", name: "Write", input: { file_path: "docs/reviews/store.md" } }],
  ]) {
    store.appendTaskEvent(task.id, "agent.assistant", "running", {
      type: "assistant",
      message: { role: "assistant", content },
    });
  }
  const outcome = interpretWorkerOutcome(1, "", SESSION_LIMIT);
  const failed: Task = {
    ...task,
    state: outcome.state,
    output: outcome.output,
    error: outcome.error!,
    completion: outcome.completion,
  };
  store.saveTask(failed, "failed", { error: failed.error, completion: failed.completion });
  return store.getTask(task.id)!;
}

// handoff launches the new run without awaiting it; returning before it settles
// leaves the worker writing to a store afterEach has already closed.
async function settled(id: string): Promise<Task> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = getTask(id);
    if (task && !["queued", "running"].includes(task.state)) return task;
    await Bun.sleep(25);
  }
  throw new Error(`task never settled: ${id}`);
}

describe("cross-profile handoff", () => {
  test("reads the reset time off the session limit that killed the run", () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    // Without this the caller cannot choose between waiting for the window and
    // spending a second account's quota — it only knows the task died.
    expect(dead.completion?.code).toBe("rate_limit");
    expect(dead.completion?.resetsAt).toBeString();
    expect(Date.parse(dead.completion!.resetsAt!)).toBeGreaterThan(Date.now());
  });

  test("moves the task to another account with its work rebuilt", async () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    const moved = await handoffTask(dead.id, "beta");
    expect(moved.id).toBe(dead.id);
    expect(moved.profileId).toBe("beta");
    // No model stated: the destination profile's own default, never alpha's,
    // which names a model on an account this run will not touch.
    expect(moved.model).toBe("beta-model");
    expect(moved.title).toBe("Review the store");
    // A fresh session: alpha's belongs to an account that cannot be reached.
    expect(getTask(dead.id)?.sessionId).toBeUndefined();

    const brief = (await settled(dead.id)).shippedPrompt ?? "";
    expect(brief).toContain(PROMPT);
    expect(brief).toContain("rate_limit");
    expect(brief).toContain("session limit");
    expect(brief).toContain("Finding: listTaskEvents drops the last row.");
    expect(brief).toContain("Read file: src/store.ts");
    expect(brief).toContain("docs/reviews/store.md");
    expect(brief).toContain("profile `alpha`");
    expect(brief).toContain(dead.completion!.resetsAt!);

    // Attempt history: one row per run, each naming where it ran.
    const settledTask = getTask(dead.id)!;
    expect(settledTask.attempts).toHaveLength(1);
    expect(settledTask.attempts?.[0]).toMatchObject({
      profileId: "alpha",
      sessionId: "sess-alpha",
      completion: { code: "rate_limit" },
    });

    const events = stateStore().listTaskEvents(dead.id);
    expect(events.filter(({ type }) => type === "handed_off")).toHaveLength(1);
    expect(events.find(({ type }) => type === "handed_off")?.payload).toMatchObject({
      fromProfile: "alpha",
      toProfile: "beta",
      previousSessionId: "sess-alpha",
    });
    expect(events.find(({ type }) => type === "handoff_brief")?.payload.tier).toBe("verbatim");
  });

  test("keeps the task's scope and flags the destination it was approved against", async () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    const moved = await handoffTask(dead.id, "beta");
    // A handoff must never widen what a task may touch on the way out.
    expect(moved.scope).toEqual({ read: ["src/**"], write: ["docs/reviews/**"] });
    expect(scopeInheritanceWarning(moved)).toContain("beta");
    expect(scopeInheritanceWarning(moved)).toContain("alpha");
    await settled(dead.id);
  });

  test("takes a stated scope as approval for the destination and records the grant", async () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    const moved = await handoffTask(dead.id, "beta", {
      scope: { read: ["src/**"], write: ["docs/**"] },
    });
    expect(moved.scope).toEqual({ read: ["src/**"], write: ["docs/**"] });
    expect(stateStore().latestScopeGrant(root, "beta")?.id).toBe(moved.grantId!);
    // Stated scope is fresh approval, so there is nothing to warn about.
    expect(scopeInheritanceWarning(moved)).toBeUndefined();
    await settled(dead.id);
  });

  test("refuses what is really a resume, an unknown profile, or a finished task", async () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    await expect(handoffTask(dead.id, "alpha")).rejects.toThrow(
      /handoff needs a different profile[\s\S]*use resume/,
    );
    await expect(handoffTask(dead.id, "ghost")).rejects.toThrow("unknown profile: ghost");
    await expect(handoffTask("no-such-task", "beta")).rejects.toThrow("unknown task: no-such-task");
    // The refusals left the task exactly where it was.
    expect(getTask(dead.id)).toMatchObject({
      profileId: "alpha",
      sessionId: "sess-alpha",
      state: "failed",
    });

    await handoffTask(dead.id, "beta");
    await settled(dead.id);
    stateStore().saveTask({ ...getTask(dead.id)!, state: "completed" }, "completed");
    await expect(handoffTask(dead.id, "alpha")).rejects.toThrow(
      "task cannot be handed off from state completed",
    );
  });

  test("leaves same-profile resume on its own account and session", async () => {
    const root = setup();
    const dead = deadOnAlpha(root);

    // resume's contract is untouched: a profile that can never capture a session
    // still refuses rather than quietly starting a fresh one somewhere else.
    await expect(resumeTask(dead.id)).rejects.toThrow(
      /custom command; provider sessions are never captured/,
    );
    expect(getTask(dead.id)).toMatchObject({
      profileId: "alpha",
      sessionId: "sess-alpha",
      state: "failed",
    });
  });
});
