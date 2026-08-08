import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { StateStore } from "../src/store";
import { LATEST_SCHEMA_VERSION } from "../src/store/schema";
import type { Profile, Task } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "claude-work",
  label: "Claude work",
  provider: "claude",
  model: "sonnet",
  enabled: true,
  env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-work" },
  capabilities: ["review"],
};

function paths() {
  const root = mkdtempSync(join(tmpdir(), "inter-store-"));
  roots.push(root);
  return { root, db: join(root, "inter.db") };
}

function task(state: Task["state"] = "queued"): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId: profile.id,
    model: "opus",
    prompt: "review",
    cwd: "/tmp/project",
    state,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** The message an open failure carries, so tests can assert on its text. */
function errorMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the store open to throw");
}

describe("SQLite state store", () => {
  test("discovers profiles once, not on every open", () => {
    const { db, root } = paths();
    const fakeHome = join(root, "home");
    mkdirSync(join(fakeHome, ".claude-alpha"), { recursive: true });
    const realHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;
      const first = new StateStore({ path: db });
      expect(first.listProfiles().map(({ id }) => id)).toContain("claude-alpha");
      first.close();

      // Discovery reads the user's home directory, which on macOS raises a
      // privacy prompt for Downloads and friends. A seeded store must never
      // pay that cost again, so a home that changed underneath is not noticed.
      mkdirSync(join(fakeHome, ".claude-beta"), { recursive: true });
      const reopened = new StateStore({ path: db });
      const ids = reopened.listProfiles().map(({ id }) => id);
      expect(ids).toContain("claude-alpha");
      expect(ids).not.toContain("claude-beta");
      reopened.close();
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  test("widens the provider check so a pi profile saves on a pre-pi database", () => {
    const { db } = paths();
    // A database built before pi carries the old CHECK, and SQLite cannot alter
    // one in place — without the rebuild the insert below fails outright.
    const legacy = new Database(db);
    legacy.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex','opencode','antigravity')),
        default_model TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        env_json TEXT NOT NULL CHECK(json_valid(env_json)),
        capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
        command_json TEXT CHECK(command_json IS NULL OR json_valid(command_json)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at TEXT
      );
      INSERT INTO profiles(id, label, provider, default_model, enabled, env_json, capabilities_json)
      VALUES ('kept', 'Kept', 'claude', 'sonnet', 1, '{}', '[]');
    `);
    legacy.close();

    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.saveProfiles([{
      id: "pi", label: "Pi", provider: "pi", model: "opencode-go/deepseek-v4-flash",
      enabled: true, env: {}, capabilities: ["build"],
    }]);
    expect(store.listProfiles().map(({ id }) => id)).toContain("pi");
    store.close();

    // saveProfiles replaces the set, so the legacy row is soft-deleted rather
    // than listed — the rebuild still has to have carried it across.
    const reopened = new Database(db);
    const rows = reopened.query<{ id: string }, []>("SELECT id FROM profiles").all();
    expect(rows.map(({ id }) => id)).toContain("kept");
    reopened.close();
  });

  test("keeps a run's result as an attempt when reply starts the next one", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const asking = task("running");
    store.createTask(asking);
    asking.state = "needs_input";
    asking.output = "read three files, need a decision";
    asking.question = "Which database?";
    store.saveTask(asking);

    const answered = store.answerTask(asking.id);

    // The work that earned the question must survive the run that answers it.
    expect(answered.state).toBe("queued");
    expect(answered.output).toBe("");
    expect(answered.question).toBeUndefined();
    expect(answered.attempts).toHaveLength(1);
    expect(answered.attempts?.[0]).toMatchObject({
      output: "read three files, need a decision",
      question: "Which database?",
    });
    store.close();
  });

  test("records the caller's answer on the answered event, not the row", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const asking = task("needs_input");
    asking.question = "Expand the write scope to api/internal/cron/builder.go?";
    store.createTask(asking);

    store.answerTask(asking.id, { answer: "Yes, expand it." });

    const answered = store.listTaskEvents(asking.id).find(({ type }) => type === "answered");
    expect(answered?.payload).toMatchObject({ attempt: 1, answer: "Yes, expand it." });
    // The decision lives on the event so an exchange stays recoverable after the
    // row's question is cleared for the next attempt.
    expect(store.getTask(asking.id)?.question).toBeUndefined();
    store.close();
  });

  test("a reply scope replaces the task scope and is recorded as the grant", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const asking = task("needs_input");
    asking.scope = { read: ["src/**"], write: ["src/**"] };
    store.createTask(asking);
    const replacement = { read: ["api/**"], write: ["api/**"] };

    const answered = store.answerTask(asking.id, {
      answer: "Granted.",
      scope: replacement,
      grantId: "grant-1",
    });

    expect(answered.scope).toEqual(replacement);
    expect(store.getTask(asking.id)?.scope).toEqual(replacement);
    expect(store.getTask(asking.id)?.grantId).toBe("grant-1");
    store.close();
  });

  test("an answer without a scope leaves the task scope untouched", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const asking = task("needs_input");
    asking.scope = { read: ["src/**"], write: ["src/**"] };
    asking.grantId = "grant-0";
    store.createTask(asking);

    store.answerTask(asking.id, { answer: "Ok." });

    expect(store.getTask(asking.id)?.scope).toEqual({ read: ["src/**"], write: ["src/**"] });
    expect(store.getTask(asking.id)?.grantId).toBe("grant-0");
    store.close();
  });

  test("keeps every earlier attempt when resume retries a failed task", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const failing = task("running");
    store.createTask(failing);
    failing.state = "failed";
    failing.output = "partial work";
    failing.error = "provider timed out";
    store.saveTask(failing);

    const resumed = store.resumeTask(failing.id);
    expect(resumed.attempts).toHaveLength(1);
    expect(resumed.attempts?.[0]).toMatchObject({
      output: "partial work",
      error: "provider timed out",
    });

    resumed.state = "failed";
    resumed.output = "second try";
    resumed.error = "failed again";
    store.saveTask(resumed);
    expect(store.resumeTask(failing.id).attempts?.map(({ output }) => output))
      .toEqual(["partial work", "second try"]);
    store.close();
  });

  test("records the resume instruction on the resumed event, not the row", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const failing = task("running");
    store.createTask(failing);
    failing.state = "failed";
    failing.error = "provider timed out";
    store.saveTask(failing);

    store.resumeTask(failing.id, { instruction: "Finish the remaining work." });

    const resumed = store.listTaskEvents(failing.id).find(({ type }) => type === "resumed");
    expect(resumed?.payload).toMatchObject({ previousState: "failed", instruction: "Finish the remaining work." });
    // A retry-style resume carries no instruction key at all, so the app never
    // offers an expansion that opens onto nothing.
    const requeued = store.getTask(failing.id)!;
    requeued.state = "failed";
    requeued.error = "provider timed out again";
    store.saveTask(requeued);
    store.resumeTask(failing.id);
    const retried = store.listTaskEvents(failing.id).filter(({ type }) => type === "resumed").at(-1);
    expect(retried?.payload.instruction).toBeUndefined();
    store.close();
  });

  test("resume carries a stated model and effort onto the row and the resumed event", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const failing = task("running");
    store.createTask(failing);
    failing.state = "failed";
    failing.error = "provider timed out";
    store.saveTask(failing);

    const resumed = store.resumeTask(failing.id, { model: "haiku", effort: "max" });
    expect(resumed.model).toBe("haiku");
    expect(resumed.effort).toBe("max");
    // Same profile and same provider session: only the model changes, which is
    // the whole point — the session is the conversation, the model is per run.
    expect(resumed.profileId).toBe(profile.id);
    expect(resumed.sessionId).toBeUndefined();
    const event = store.listTaskEvents(failing.id).find(({ type }) => type === "resumed");
    expect(event?.payload).toMatchObject({ model: "haiku", effort: "max" });
    store.close();
  });

  test("resume without model or effort keeps the values the row already has", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const failing = task("running");
    failing.model = "sonnet";
    failing.effort = "high";
    store.createTask(failing);
    failing.state = "failed";
    failing.error = "provider timed out";
    store.saveTask(failing);

    const resumed = store.resumeTask(failing.id);
    expect(resumed.model).toBe("sonnet");
    expect(resumed.effort).toBe("high");
    store.close();
  });

  test("resume holds the profile and session steady where handoff moves them", () => {
    const { db } = paths();
    const spare: Profile = { ...profile, id: "claude-spare", model: "haiku" };
    const store = new StateStore({ path: db, seedProfiles: [profile, spare] });
    const failing = task("running");
    store.createTask(failing);
    store.captureTaskSessionId(failing.id, "claude", "sess-alpha");
    failing.state = "failed";
    failing.output = "partial findings";
    failing.error = "session limit";
    store.saveTask(failing);

    // Resume's contract: same account, same provider session, every time.
    const resumed = store.resumeTask(failing.id);
    expect(resumed.profileId).toBe(profile.id);
    expect(resumed.sessionId).toBe("sess-alpha");
    expect(resumed.attempts?.[0]).toMatchObject({
      profileId: profile.id,
      sessionId: "sess-alpha",
    });

    resumed.state = "failed";
    resumed.output = "still stuck";
    store.saveTask(resumed);

    const handed = store.handoffTask(failing.id, {
      profileId: spare.id,
      model: "haiku",
      effort: "max",
    });
    expect(handed).toMatchObject({
      profileId: spare.id,
      model: "haiku",
      effort: "max",
      state: "queued",
      // Same row, same lineage: only the destination changed.
      prompt: failing.prompt,
      cwd: failing.cwd,
    });
    // The new run has no session yet; the old account's survives on the attempt
    // it belongs to rather than being overwritten on the row.
    expect(handed.sessionId).toBeUndefined();
    expect(handed.attempts?.map(({ profileId, sessionId }) => [profileId, sessionId])).toEqual([
      [profile.id, "sess-alpha"],
      [profile.id, "sess-alpha"],
    ]);
    expect(store.listTaskEvents(failing.id).at(-1)).toMatchObject({
      type: "handed_off",
      payload: { fromProfile: profile.id, toProfile: spare.id, previousSessionId: "sess-alpha" },
    });
    store.close();
  });

  test("refuses a handoff from a state that is not resumable", () => {
    const { db } = paths();
    const spare: Profile = { ...profile, id: "claude-spare" };
    const store = new StateStore({ path: db, seedProfiles: [profile, spare] });
    const done = task("running");
    store.createTask(done);
    done.state = "completed";
    store.saveTask(done);

    expect(() => store.handoffTask(done.id, { profileId: spare.id, model: "haiku" }))
      .toThrow("task cannot be handed off");
    expect(store.getTask(done.id)?.profileId).toBe(profile.id);
    store.close();
  });

  test("cancels a task parked on a question or blocked mid-run", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    for (const state of ["needs_input", "blocked"] as const) {
      const parked = task("running");
      store.createTask(parked);
      parked.state = state;
      store.saveTask(parked);

      const cancelled = store.cancelTask(parked.id, "no longer useful", {
        blocked: true,
        code: "cancelled",
        reason: "no longer useful",
      });
      expect(cancelled?.state).toBe("cancelled");
    }
    // A task that already finished still cannot be cancelled.
    const done = task("running");
    store.createTask(done);
    done.state = "completed";
    store.saveTask(done);
    expect(store.cancelTask(done.id, "too late", {
      blocked: true,
      code: "cancelled",
      reason: "too late",
    })).toBeUndefined();
    store.close();
  });

  test("asserts completion over blocked and failed only, keeping the original completion", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const dead = task("blocked");
    store.createTask(dead);
    dead.completion = { blocked: true, code: "unverified", reason: "no marker" };
    store.saveTask(dead);

    const asserted = store.assertTaskCompletion(dead.id, { assertedBy: "alice", reason: "checked by hand" });
    expect(asserted.state).toBe("completed");
    expect(asserted.completion).toMatchObject({
      code: "unverified",
      blocked: true,
      assertedCompletion: {
        assertedBy: "alice",
        reason: "checked by hand",
        replacedCode: "unverified",
      },
    });

    // The store refuses anything that is not a dead, unattested run.
    const running = task("running");
    store.createTask(running);
    expect(() => store.assertTaskCompletion(running.id, { assertedBy: "alice", reason: "looks done" }))
      .toThrow("task cannot be asserted completed from state running");
    const done = task("completed");
    store.createTask(done);
    expect(() => store.assertTaskCompletion(done.id, { assertedBy: "alice", reason: "still fine" }))
      .toThrow("task cannot be asserted completed from state completed");
    store.close();
  });

  test("probes task states without materialising full rows", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const running = task("running");
    const asking = task("needs_input");
    store.createTask(running);
    store.createTask(asking);

    // The waiter's poll path reads exactly id and state, nothing else.
    expect(store.taskStates([running.id, asking.id]))
      .toEqual(new Map([[running.id, "running"], [asking.id, "needs_input"]]));
    expect(store.taskStates(["missing"])).toEqual(new Map());
    expect(store.taskStates([])).toEqual(new Map());

    running.state = "completed";
    running.updatedAt = new Date().toISOString();
    store.saveTask(running);
    expect(store.taskStates([running.id]).get(running.id)).toBe("completed");
    store.close();
  });

  test("finds a fan-out batch by its parent task", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("completed");
    store.createTask(parent);
    const child = { ...task("completed"), parentTaskId: parent.id };
    store.createTask(child);
    store.createTask(task("completed"));

    // The batch is the parent plus its children, and nothing else.
    expect(new Set(store.listTaskSummaries({ parent: parent.id }).map(({ id }) => id)))
      .toEqual(new Set([parent.id, child.id]));
    expect(store.listTaskSummaries({}).length).toBe(3);
    store.close();
  });

  test("composes the parent filter with the state filter", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("completed");
    store.createTask(parent);
    const done = { ...task("completed"), parentTaskId: parent.id };
    const running = { ...task("running"), parentTaskId: parent.id };
    store.createTask(done);
    store.createTask(running);

    expect(new Set(store.listTaskSummaries({ parent: parent.id, state: "completed" }).map(({ id }) => id)))
      .toEqual(new Set([parent.id, done.id]));
    expect(new Set(store.listTaskSummaries({ parent: parent.id, state: "running" }).map(({ id }) => id)))
      .toEqual(new Set([running.id]));
    store.close();
  });

  test("composes the parent filter with the archived filter", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("completed");
    store.createTask(parent);
    const kept = { ...task("completed"), parentTaskId: parent.id };
    const hidden = { ...task("completed"), parentTaskId: parent.id };
    store.createTask(kept);
    store.createTask(hidden);
    store.setTaskArchived(hidden.id, true);

    expect(new Set(store.listTaskSummaries({ parent: parent.id }).map(({ id }) => id)))
      .toEqual(new Set([parent.id, kept.id]));
    expect(new Set(store.listTaskSummaries({ parent: parent.id, archived: "include" }).map(({ id }) => id)))
      .toEqual(new Set([parent.id, kept.id, hidden.id]));
    expect(new Set(store.listTaskSummaries({ parent: parent.id, archived: "only" }).map(({ id }) => id)))
      .toEqual(new Set([hidden.id]));
    store.close();
  });

  test("accumulates reported spend across runs of one task", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    store.createTask(work);
    expect(store.getTask(work.id)?.costUsd).toBeUndefined();

    store.recordTaskCost(work.id, 1.64, 21);
    expect(store.getTask(work.id)).toMatchObject({ costUsd: 1.64, turns: 21 });

    // A reply or resume is another run on the same task, so spend adds up.
    store.recordTaskCost(work.id, 0.36, 4);
    expect(store.getTask(work.id)).toMatchObject({ costUsd: 2, turns: 25 });
    store.close();
  });

  test("accumulates token usage alongside cost and turns", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    store.createTask(work);

    store.recordTaskCost(work.id, 0.01, 1, 1938, 113);
    store.recordTaskCost(work.id, undefined, undefined, 142, 1160);
    const totals = store.spendTotals();
    expect(totals.tokens).toBe(1938 + 113 + 142 + 1160);
    store.close();
  });

  test("leaves spend unknown when the run reported turns but no price", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    store.createTask(work);

    store.recordTaskCost(work.id, undefined, 7, 400, 90);
    const settled = store.getTask(work.id);
    expect(settled?.turns).toBe(7);
    expect(settled?.costUsd).toBeUndefined();

    // A later run that does report a price starts from the price, not from a
    // zero the first run never stated.
    store.recordTaskCost(work.id, 0.25, 2);
    expect(store.getTask(work.id)?.costUsd).toBe(0.25);
    store.close();
  });

  test("counts settled tasks with no reported price so the total reads as a floor", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const priced = task("completed");
    const unpriced = task("completed");
    const running = task("running");
    for (const row of [priced, unpriced, running]) store.createTask(row);
    store.recordTaskCost(priced.id, 0.5, 3);
    store.recordTaskCost(unpriced.id, undefined, 3);

    const totals = store.spendTotals();
    expect(totals.costUsd).toBe(0.5);
    // The in-flight task has no price yet either, but it has not finished, so
    // it is not something the window failed to read.
    expect(totals.unpricedTasks).toBe(1);
    store.close();
  });

  test("attributes a rate limit to the model that hit it", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.recordProfileFailure(profile.id, "rate_limit", "429", undefined, "fable");
    expect(store.listProfileFailures()[0]).toMatchObject({ code: "rate_limit", model: "fable" });

    // An account-wide failure (no model) is its own row: it must not overwrite
    // a still-live rate limit on a specific model of the same profile.
    store.recordProfileFailure(profile.id, "auth", "invalid key");
    const failures = store.listProfileFailures();
    expect(failures).toHaveLength(2);
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "rate_limit", model: "fable" }),
      expect.objectContaining({ code: "auth" }),
    ]));
    expect(failures.find((f) => f.code === "auth")).not.toHaveProperty("model");
    store.close();
  });

  describe("spendTotals", () => {
    test("sums cost and tokens across tasks inside the window, and ignores what predates it", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      const recent = task("completed");
      const stale = task("completed");
      store.createTask(recent);
      store.createTask(stale);
      store.recordTaskCost(recent.id, 1.5, 3, 1000, 500);
      store.recordTaskCost(stale.id, 9, 9, 9_000, 9_000);

      // Backdate the stale task's updated_at past the window without touching
      // the one meant to still count.
      const raw = new Database(db);
      raw.query("UPDATE tasks SET updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), stale.id);
      raw.close();

      const totals = store.spendTotals(24 * 60 * 60 * 1000);
      expect(totals.costUsd).toBe(1.5);
      expect(totals.tokens).toBe(1500);
      store.close();
    });

    test("reports zero cost and zero tokens rather than nulls when nothing is in the window", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      expect(store.spendTotals()).toMatchObject({ costUsd: 0, tokens: 0 });
      store.close();
    });

    test("drops a settled task's cost when the window rolls past it, with no data changing", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      const done = task("completed");
      store.createTask(done);
      store.recordTaskCost(done.id, 5, 3, 1000, 500);

      // The task finished 23 hours ago: inside the window.
      const raw = new Database(db);
      const backdate = (hours: number) =>
        raw.query("UPDATE tasks SET updated_at = ? WHERE id = ?")
          .run(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(), done.id);
      backdate(23);
      const before = store.spendTotals();
      expect(before.costUsd).toBe(5);
      expect(before.tokens).toBe(1500);

      // Two hours later nothing about the row changed; only the boundary
      // moved, so the same cost is now outside it — the shrink the footer
      // used to exhibit without saying it was a window.
      backdate(25);
      const after = store.spendTotals();
      expect(after.costUsd).toBe(0);
      expect(after.tokens).toBe(0);
      raw.close();
      store.close();
    });

    test("a task that genuinely cost zero is not counted as unpriced", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      const free = task("completed");
      const unknown = task("completed");
      store.createTask(free);
      store.createTask(unknown);
      // opencode and pi report a real zero; NULL means "the provider never
      // said" and is what the floor marker counts.
      store.recordTaskCost(free.id, 0, 2, 500, 300);
      store.recordTaskCost(unknown.id, undefined, 2);

      const totals = store.spendTotals();
      expect(totals.costUsd).toBe(0);
      expect(totals.unpricedTasks).toBe(1);
      store.close();
    });

    test("says how long a window it summed over", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      const done = task("completed");
      store.createTask(done);
      store.recordTaskCost(done.id, 0.25, 1, 10, 10);

      expect(store.spendTotals().windowMs).toBe(24 * 60 * 60 * 1000);
      expect(store.spendTotals(60 * 60 * 1000).windowMs).toBe(60 * 60 * 1000);
      store.close();
    });
  });

  test("stores the prompt the worker actually received", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    store.createTask(work);
    expect(store.getTask(work.id)?.shippedPrompt).toBeUndefined();

    store.recordShippedPrompt(work.id, "review\n\n## Memories\nUse SQLite");
    expect(store.getTask(work.id)?.prompt).toBe("review");
    expect(store.getTask(work.id)?.shippedPrompt).toBe("review\n\n## Memories\nUse SQLite");
    store.close();
  });

  test("persists project memories and protects concurrent updates", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [] });
    const first = store.setMemory("/tmp/project-a", "architecture/db", "Use SQLite");
    expect(first.version).toBe(1);
    expect(store.listMemories("/tmp/project-b")).toEqual([]);
    expect(store.setMemory("/tmp/project-a", "architecture/db", "Use WAL", 1).version).toBe(2);
    expect(() => store.setMemory("/tmp/project-a", "architecture/db", "stale", 1))
      .toThrow("memory version conflict: expected 1, found 2");
    store.close();

    const reopened = new StateStore({ path: db, seedProfiles: [] });
    expect(reopened.getMemory("/tmp/project-a", "architecture/db")?.value).toBe("Use WAL");
    expect(reopened.deleteMemory("/tmp/project-a", "architecture/db", 2)).toBe(true);
    expect(reopened.getMemory("/tmp/project-a", "architecture/db")).toBeUndefined();
    reopened.close();
  });

  test("groups memories by project and forgets a project with none left", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [] });
    expect(store.listMemoryProjects()).toEqual([]);

    store.setMemory("/tmp/project-a", "architecture/db", "Use SQLite");
    store.setMemory("/tmp/project-a", "style/tests", "Bun test");
    store.setMemory("/tmp/project-b", "owner", "Malico");

    const [first, second] = store.listMemoryProjects();
    expect(first).toMatchObject({ cwd: "/tmp/project-a", count: 2, chars: 18 });
    expect(second).toMatchObject({ cwd: "/tmp/project-b", count: 1, chars: 6 });

    // The newest write dates the whole project.
    const rewritten = store.setMemory("/tmp/project-a", "style/tests", "Bun test, no mocks");
    expect(store.listMemoryProjects()[0]).toMatchObject({
      count: 2,
      chars: 28,
      updatedAt: rewritten.updatedAt,
    });

    expect(store.deleteMemory("/tmp/project-b", "owner")).toBe(true);
    expect(store.listMemoryProjects().map(({ cwd }) => cwd)).toEqual(["/tmp/project-a"]);
    store.close();
  });

  test("starts without default profiles and preserves user deletion", () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [] });
    expect(first.listProfiles()).toEqual([]);
    first.saveProfiles([profile]);
    first.saveProfiles([]);
    first.close();

    const reopened = new StateStore({ path: db, seedProfiles: [] });
    expect(reopened.listProfiles()).toEqual([]);
    reopened.close();
  });

  test("round-trips reasoning effort so a resumed run keeps the level", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const withEffort = { ...task(), effort: "xhigh" };
    store.createTask(withEffort);
    expect(store.getTask(withEffort.id)!.effort).toBe("xhigh");

    // Absent stays absent rather than surfacing as an empty string.
    const withoutEffort = task();
    store.createTask(withoutEffort);
    expect(store.getTask(withoutEffort.id)!.effort).toBeUndefined();
    store.close();
  });

  test("round-trips a caller tldr and leaves it undefined when absent", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const withTldr = { ...task(), tldr: "Add dark mode and run the tests" };
    store.createTask(withTldr);
    expect(store.getTask(withTldr.id)!.tldr).toBe("Add dark mode and run the tests");
    // The app's task list reads summaries, so the handle has to ride them too.
    expect(store.listTaskSummaries({}).find(({ id }) => id === withTldr.id)?.tldr)
      .toBe("Add dark mode and run the tests");

    // No tldr stays absent rather than surfacing as an empty string.
    const withoutTldr = task();
    store.createTask(withoutTldr);
    expect(store.getTask(withoutTldr.id)!.tldr).toBeUndefined();
    store.close();
  });

  test("migrates databases without the tldr column, leaving rows readable", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = { ...task(), tldr: "Write a README for the auth package" };
    store.createTask(saved);
    expect(store.getTask(saved.id)?.tldr).toBe("Write a README for the auth package");
    store.close();

    // Simulate a database created before the tldr migration.
    const raw = new Database(db);
    raw.exec("ALTER TABLE tasks DROP COLUMN tldr");
    raw.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.getTask(saved.id)).toMatchObject({ id: saved.id, prompt: saved.prompt });
    expect(reopened.getTask(saved.id)?.tldr).toBeUndefined();
    reopened.close();
  });

  test("round-trips a caller title and leaves it undefined when absent", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const withTitle = { ...task(), title: "Add dark mode" };
    store.createTask(withTitle);
    expect(store.getTask(withTitle.id)!.title).toBe("Add dark mode");
    // The app's task list reads summaries, so the label has to ride them too.
    expect(store.listTaskSummaries({}).find(({ id }) => id === withTitle.id)?.title)
      .toBe("Add dark mode");

    // No title stays absent rather than surfacing as an empty string.
    const withoutTitle = task();
    store.createTask(withoutTitle);
    expect(store.getTask(withoutTitle.id)!.title).toBeUndefined();
    store.close();
  });

  test("migrates databases without the title column, leaving rows readable", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = { ...task(), title: "Write a README" };
    store.createTask(saved);
    expect(store.getTask(saved.id)?.title).toBe("Write a README");
    store.close();

    // Simulate a database created before the title migration.
    const raw = new Database(db);
    raw.exec("ALTER TABLE tasks DROP COLUMN title");
    raw.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.getTask(saved.id)).toMatchObject({ id: saved.id, prompt: saved.prompt });
    expect(reopened.getTask(saved.id)?.title).toBeUndefined();
    reopened.close();
  });

  test("persists terminal tasks and ordered lifecycle events", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task();
    store.createTask(saved);
    store.appendTaskEvent(saved.id, "agent.tool", saved.state, { name: "read_file" });
    saved.state = "completed";
    saved.output = "done";
    saved.updatedAt = new Date().toISOString();
    store.saveTask(saved, "completed");
    expect(store.listTaskEvents(saved.id).map(({ type }) => type))
      .toEqual(["created", "agent.tool", "completed"]);
    const firstCursor = store.listTaskEvents(saved.id)[0]!.id;
    expect(store.listTaskEvents(saved.id, firstCursor).map(({ type }) => type))
      .toEqual(["agent.tool", "completed"]);
    expect(store.latestTaskEventId([saved.id])).toBe(
      store.listTaskEvents(saved.id).at(-1)!.id,
    );
    store.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.getTask(saved.id)?.output).toBe("done");
    expect(reopened.getTask(saved.id)?.state).toBe("completed");
    reopened.close();
  });

  test("persists captured worker session ids, adding the column to older databases", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task();
    store.createTask(saved);
    expect(store.getTask(saved.id)?.sessionId).toBeUndefined();
    expect(store.captureTaskSessionId(saved.id, "claude", "sess-123")).toBe(true);
    expect(store.captureTaskSessionId(saved.id, "claude", "sess-other")).toBe(false);
    expect(store.getTask(saved.id)?.sessionId).toBe("sess-123");
    expect(store.listTaskSummaries()[0]?.sessionId).toBe("sess-123");
    const sessionEvents = store.listTaskEvents(saved.id)
      .filter(({ type }) => type === "session_captured");
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]?.payload).toEqual({
      provider: "claude",
      sessionId: "sess-123",
    });
    store.close();

    // Simulate a database created before the session_id migration.
    const raw = new Database(db);
    raw.exec("ALTER TABLE tasks DROP COLUMN session_id");
    raw.exec("DELETE FROM schema_migrations WHERE version = 4");
    raw.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.getTask(saved.id)?.sessionId).toBeUndefined();
    reopened.captureTaskSessionId(saved.id, "claude", "sess-456");
    expect(reopened.getTask(saved.id)?.sessionId).toBe("sess-456");
    reopened.close();
  });

  test("clearCapturedSession drops the session so a fresh run can record its own", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task();
    store.createTask(saved);
    store.captureTaskSessionId(saved.id, "claude", "sess-dead");
    expect(store.getTask(saved.id)?.sessionId).toBe("sess-dead");

    store.clearCapturedSession(saved.id);
    expect(store.getTask(saved.id)?.sessionId).toBeUndefined();
    expect(store.captureTaskSessionId(saved.id, "claude", "sess-fresh")).toBe(true);
    expect(store.getTask(saved.id)?.sessionId).toBe("sess-fresh");
    store.close();
  });

  test("backfills earliest native session ids from historical provider events", () => {
    const { db } = paths();
    const profiles: Profile[] = [
      profile,
      { ...profile, id: "codex", provider: "codex" },
      { ...profile, id: "opencode", provider: "opencode" },
      { ...profile, id: "antigravity", provider: "antigravity" },
    ];
    const store = new StateStore({ path: db, seedProfiles: profiles });
    const cases = [
      ["claude-work", { type: "assistant", session_id: "child" }, { type: "system", session_id: "claude-first" }, { type: "system", session_id: "claude-later" }],
      ["codex", { type: "item.started", thread_id: "child" }, { type: "thread.started", thread_id: "codex-first" }, { type: "thread.started", thread_id: "codex-later" }],
      ["opencode", { type: "tool_use", sessionID: "child" }, { type: "step_start", sessionID: "opencode-first" }, { type: "step_start", sessionID: "opencode-later" }],
      ["antigravity", { session_id: "unsupported" }, { session_id: "still-unsupported" }],
    ] as const;
    const ids: Record<string, string> = {};
    for (const [profileId, ...payloads] of cases) {
      const saved = { ...task(), profileId };
      ids[profileId] = saved.id;
      store.createTask(saved);
      for (const payload of payloads) {
        store.appendTaskEvent(saved.id, "agent.event", saved.state, payload);
      }
    }
    const existing = task();
    store.createTask(existing);
    store.appendTaskEvent(existing.id, "agent.system", existing.state, {
      session_id: "historical-id",
    });
    store.captureTaskSessionId(existing.id, "claude", "keep-existing");
    store.close();
    const raw = new Database(db);
    raw.exec("DELETE FROM schema_migrations WHERE version = 5");
    raw.close();

    const repaired = new StateStore({ path: db, seedProfiles: profiles });
    expect(repaired.getTask(ids["claude-work"]!)?.sessionId).toBe("claude-first");
    expect(repaired.getTask(ids.codex!)?.sessionId).toBe("codex-first");
    expect(repaired.getTask(ids.opencode!)?.sessionId).toBe("opencode-first");
    expect(repaired.getTask(ids.antigravity!)?.sessionId).toBeUndefined();
    expect(repaired.getTask(existing.id)?.sessionId).toBe("keep-existing");
    for (const profileId of ["claude-work", "codex", "opencode"]) {
      expect(repaired.listTaskEvents(ids[profileId]!)
        .filter(({ type }) => type === "session_captured")).toHaveLength(1);
    }
    repaired.close();
  });

  test("lists no tasks when empty and orders tasks by latest update", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    expect(store.listTasks()).toEqual([]);

    const older = task("completed");
    older.updatedAt = "2026-07-29T10:00:00.000Z";
    const newer = task("queued");
    newer.updatedAt = "2026-07-29T11:00:00.000Z";
    store.createTask(older);
    store.createTask(newer);

    expect(store.listTasks().map(({ id }) => id)).toEqual([newer.id, older.id]);
    store.close();
  });

  test("soft-archives tasks and hides them from active lists", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task("completed");
    store.createTask(saved);

    const archived = store.setTaskArchived(saved.id, true);
    expect(archived.archivedAt).toBeString();
    expect(store.getTask(saved.id)?.archivedAt).toBe(archived.archivedAt);
    expect(store.listTasks()).toEqual([]);
    expect(store.listTaskSummaries()).toEqual([]);
    expect(store.listTasks(200, "only").map(({ id }) => id)).toEqual([saved.id]);
    expect(store.listTaskSummaries({ archived: "include" })[0]?.archivedAt).toBe(archived.archivedAt);

    const restored = store.setTaskArchived(saved.id, false);
    expect(restored.archivedAt).toBeUndefined();
    expect(store.listTasks().map(({ id }) => id)).toEqual([saved.id]);
    expect(store.listTaskEvents(saved.id).slice(-2).map(({ type }) => type))
      .toEqual(["archived", "unarchived"]);
    store.close();
  });

  test("marks running work failed after broker restart", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const interrupted = task("running");
    store.createTask(interrupted);
    store.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.getTask(interrupted.id)?.state).toBe("failed");
    expect(reopened.listTaskEvents(interrupted.id).map(({ type }) => type))
      .toEqual(["created", "broker_restarted"]);
    reopened.close();
  });

  test("soft-deletes profiles without losing task history", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task("completed");
    store.createTask(saved);
    store.saveProfiles([]);
    expect(store.listProfiles()).toEqual([]);
    expect(store.getTask(saved.id)?.profileId).toBe(profile.id);
    store.close();
  });

  test("reuses a recorded scope grant when a later task states none", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const scope = { read: ["src/**"], write: [] };
    const grant = store.recordScopeGrant("/tmp/project", "claude-work", scope);

    expect(store.latestScopeGrant("/tmp/project", "claude-work")?.id).toBe(grant.id);
    expect(store.latestScopeGrant("/tmp/project", "claude-work")?.scope).toEqual(scope);
    expect(store.latestScopeGrant("/tmp/other", "claude-work")).toBeUndefined();

    // Re-stating the same scope refreshes the grant instead of forking it.
    expect(store.recordScopeGrant("/tmp/project", "claude-work", scope).id).toBe(grant.id);
    expect(store.listScopeGrants()).toHaveLength(1);
    expect(store.getScopeGrant(grant.id)?.useCount).toBe(2);

    expect(store.revokeScopeGrant(grant.id)).toBe(true);
    expect(store.latestScopeGrant("/tmp/project", "claude-work")).toBeUndefined();
    store.close();
  });

  test("prefers a profile's own grant and reports when it borrows another's", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const wide = { read: ["**"], write: ["**"] };
    const narrow = { read: ["src/**"], write: [] };
    store.recordScopeGrant("/tmp/project", "trusted", wide);
    const own = store.recordScopeGrant("/tmp/project", "sketchy", narrow);

    // A profile with its own approval uses it, even though the other grant is
    // wider and was recorded first.
    const mine = store.latestScopeGrant("/tmp/project", "sketchy");
    expect(mine?.id).toBe(own.id);
    expect(mine?.scope).toEqual(narrow);

    // A profile the user never approved here still gets an answer, but one
    // stamped with whose approval it is, so the caller can flag the reuse.
    const borrowed = store.latestScopeGrant("/tmp/project", "never-approved");
    expect(borrowed).toBeDefined();
    expect(borrowed!.profileId).not.toBe("never-approved");
    store.close();
  });

  test("keeps only the most recent attempts so a long chain cannot grow forever", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    store.createTask(work);

    for (let run = 1; run <= 14; run++) {
      work.state = "failed";
      work.output = `run ${run}`;
      work.error = `failed ${run}`;
      store.saveTask(work);
      Object.assign(work, store.resumeTask(work.id));
    }

    const attempts = store.getTask(work.id)?.attempts ?? [];
    expect(attempts).toHaveLength(10);
    // The oldest are dropped, not the newest.
    expect(attempts.at(0)?.output).toBe("run 5");
    expect(attempts.at(-1)?.output).toBe("run 14");

    // Summaries never pay to parse that history.
    const summary = store.listTaskSummaries({}).find(({ id }) => id === work.id);
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("attempts");
    store.close();
  });

  test("returns filtered summaries without full prompts or outputs", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task("completed");
    saved.prompt = "x".repeat(500);
    saved.output = "secret output";
    store.createTask(saved);
    const [summary] = store.listTaskSummaries({ limit: 1, state: "completed", profile: profile.id });
    expect(summary?.promptPreview.length).toBe(240);
    expect(summary).not.toHaveProperty("output");
    expect(store.listTaskSummaries({ state: "failed" })).toEqual([]);
    store.close();
  });

  test("defaults to 20 summaries and caps the working set at 500", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    for (let i = 0; i < 510; i++) store.createTask(task("completed"));
    expect(store.listTaskSummaries({}).length).toBe(20);
    expect(store.listTaskSummaries({ limit: 1000 }).length).toBe(500);
    store.close();
  });

  // The sidebar's "Load more" learns whether another page exists by asking
  // for `pageSize + 1` rows and checking whether it got more than `pageSize`
  // back — the same trick `listTaskEventsTail` uses for `hasEarlier`. These
  // pin that probe at its three boundaries.
  describe("the limit+1 probe /api/state uses to compute tasksHasMore", () => {
    test("an empty page returns nothing to page into", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      expect(store.listTaskSummaries({ limit: 51 }).length).toBe(0);
      store.close();
    });

    test("exactly one page returns no more than requested", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      for (let i = 0; i < 50; i++) store.createTask(task("completed"));
      expect(store.listTaskSummaries({ limit: 51 }).length).toBe(50);
      store.close();
    });

    test("one more than a page returns the extra row the probe expects", () => {
      const { db } = paths();
      const store = new StateStore({ path: db, seedProfiles: [profile] });
      for (let i = 0; i < 51; i++) store.createTask(task("completed"));
      expect(store.listTaskSummaries({ limit: 51 }).length).toBe(51);
      store.close();
    });
  });

  test("treats heartbeats as progress reporting, not as meaningful events", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const first = task("running");
    const second = task("running");
    store.createTask(first);
    store.createTask(second);
    const cursor = store.latestTaskEventId([first.id, second.id], true);
    store.appendTaskEvent(first.id, "agent.system", first.state, { noise: true });
    store.appendTaskEvent(second.id, "heartbeat", second.state, {
      elapsedMs: 10_000,
      silentMs: 4_000,
      stalled: false,
    });

    // Heartbeats fire on a timer, so counting them would advance the cursor
    // every 10s and wake a caller that has no new news to read.
    expect(store.listTaskEventsForTasks([first.id, second.id], cursor, 10, true)).toEqual([]);
    expect(store.latestTaskEventId([first.id, second.id], true)).toBe(cursor);
    // The progress summary still carries what the heartbeat measured.
    expect(store.latestTaskProgress([first.id, second.id])[second.id]).toMatchObject({
      elapsedMs: 10_000,
      silentMs: 4_000,
      stalled: false,
    });

    store.appendTaskEvent(first.id, "agent.assistant", first.state, { real: true });
    expect(store.listTaskEventsForTasks([first.id, second.id], cursor, 10, true)
      .map(({ type }) => type)).toEqual(["agent.assistant"]);
    expect(store.latestTaskEventId([first.id, second.id], true)).toBeGreaterThan(cursor);
    store.close();
  });

  test("atomically requeues an answered task in place", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("needs_input");
    parent.question = "Which file?";
    parent.output = "INTER_NEEDS_INPUT: Which file?";
    parent.completion = { blocked: true, code: "needs_authority" };
    store.createTask(parent);
    expect(store.answerTask(parent.id)).toMatchObject({
      id: parent.id,
      state: "queued",
      output: "",
    });
    expect(store.getTask(parent.id)?.question).toBeUndefined();
    expect(store.getTask(parent.id)?.completion).toBeUndefined();
    expect(() => store.answerTask(parent.id)).toThrow("does not need input");
    store.close();
  });

  test("resumes the same task record and clears the prior outcome", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("failed");
    parent.output = "partial";
    parent.error = "crashed";
    parent.completion = { blocked: true, code: "worker_error" };
    store.createTask(parent);
    expect(store.resumeTask(parent.id, {
      timeoutMs: 5_000,
      scope: { read: ["src/**"], write: ["src/**"] },
      allowQuestions: false,
    })).toMatchObject({
      id: parent.id,
      state: "queued",
      output: "",
      timeoutMs: 5_000,
      scope: { read: ["src/**"], write: ["src/**"] },
      allowQuestions: false,
    });
    expect(store.getTask(parent.id)?.error).toBeUndefined();
    expect(store.getTask(parent.id)?.completion).toBeUndefined();
    expect(() => store.resumeTask(parent.id))
      .toThrow("task cannot be resumed");
    store.close();
  });

  test("records and clears routable profile failures", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.recordProfileFailure(profile.id, "billing", "Insufficient balance");
    store.recordProfileFailure(profile.id, "billing", "Still empty");
    expect(store.listProfileFailures()[0]).toMatchObject({
      profileId: profile.id,
      code: "billing",
      consecutiveFailures: 2,
    });
    store.clearProfileFailure(profile.id);
    expect(store.listProfileFailures()).toEqual([]);
    store.close();
  });

  test("keeps a rate limit on one model live while another model of the same profile clears", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.recordProfileFailure(profile.id, "rate_limit", "sonnet exhausted", undefined, "sonnet");
    store.recordProfileFailure(profile.id, "rate_limit", "opus exhausted", undefined, "opus");
    // Before this fix, a single profile_id primary key meant the opus row
    // above would have overwritten the sonnet one instead of coexisting.
    expect(store.listProfileFailures()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: profile.id, model: "sonnet", message: "sonnet exhausted" }),
        expect.objectContaining({ profileId: profile.id, model: "opus", message: "opus exhausted" }),
      ]),
    );
    expect(store.listProfileFailures()).toHaveLength(2);

    // Success on sonnet clears only sonnet's row.
    store.clearProfileFailure(profile.id, "sonnet");
    expect(store.listProfileFailures()).toEqual([
      expect.objectContaining({ profileId: profile.id, model: "opus" }),
    ]);
    store.close();
  });

  test("clearing a model also drops the account-wide failure, not just that model's own", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.recordProfileFailure(profile.id, "auth", "invalid api key");
    store.recordProfileFailure(profile.id, "rate_limit", "opus exhausted", undefined, "opus");
    store.clearProfileFailure(profile.id, "sonnet");
    // sonnet never had its own row, but the account-wide auth failure is
    // proven wrong by any successful run, so it clears; opus stays live.
    expect(store.listProfileFailures()).toEqual([
      expect.objectContaining({ profileId: profile.id, model: "opus" }),
    ]);
    store.close();
  });

  test("persists rate-limit retry times and successful generation evidence", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const retryAt = "2026-07-30T12:30:00.000Z";
    store.recordProfileFailure(profile.id, "rate_limit", "Too many requests", retryAt);
    expect(store.listProfileFailures()[0]).toMatchObject({
      profileId: profile.id,
      code: "rate_limit",
      retryAt,
    });

    const completed = task("completed");
    completed.updatedAt = "2026-07-30T12:45:00.000Z";
    store.createTask(completed);
    expect(store.listProfileSuccesses()).toEqual([{
      profileId: profile.id,
      succeededAt: completed.updatedAt,
    }]);
    store.close();

    const reopened = new StateStore({ path: db, seedProfiles: [profile] });
    expect(reopened.listProfileFailures()[0]?.retryAt).toBe(retryAt);
    expect(reopened.listProfileSuccesses()[0]?.succeededAt).toBe(completed.updatedAt);
    reopened.close();
  });

  test("lands timeouts in failed so callers can tell them from caller stops", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const running = task("running");
    store.createTask(running);
    const timedOut = store.cancelTask(running.id, "task exceeded timeoutMs 50", {
      blocked: true,
      code: "timeout",
      reason: "task exceeded timeoutMs 50",
    });
    expect(timedOut?.state).toBe("failed");
    expect(store.listTaskEvents(running.id).at(-1)?.type).toBe("failed");
    store.close();
  });

  test("does not let worker completion overwrite cancellation", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const running = task("running");
    store.createTask(running);
    expect(store.cancelTask(running.id, "stop", {
      blocked: true,
      code: "cancelled",
      reason: "stop",
    })?.state).toBe("cancelled");
    running.state = "completed";
    running.completion = { blocked: false, code: "completed" };
    expect(store.saveTask(running, "completed", {}, ["running"])).toBe(false);
    expect(store.getTask(running.id)?.state).toBe("cancelled");
    store.close();
  });

  test("migrates existing task rows to the expanded lifecycle contract", () => {
    const { db } = paths();
    const old = new Database(db, { create: true });
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profiles(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL,
        default_model TEXT NOT NULL, enabled INTEGER NOT NULL, env_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, command_json TEXT, created_at TEXT, updated_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE tasks(
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), model TEXT NOT NULL,
        prompt TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL, output TEXT NOT NULL,
        error TEXT, question TEXT, parent_task_id TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    old.query(`
      INSERT INTO profiles(
        id, label, provider, default_model, enabled, env_json, capabilities_json,
        command_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, '{}', '[]', NULL, ?, ?)
    `).run(profile.id, profile.label, profile.provider, profile.model, new Date().toISOString(), new Date().toISOString());
    const legacyTask = task("completed");
    old.query(`
      INSERT INTO tasks(
        id, profile_id, model, prompt, cwd, state, output, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyTask.id, legacyTask.profileId, legacyTask.model, legacyTask.prompt,
      legacyTask.cwd, legacyTask.state, legacyTask.output, legacyTask.createdAt, legacyTask.updatedAt,
    );
    old.close();

    const store = new StateStore({ path: db, seedProfiles: [profile] });
    expect(store.getTask(legacyTask.id)).toMatchObject({
      state: "completed",
      scope: { read: ["**"], write: ["**"] },
      allowQuestions: true,
    });
    const migrated = store.getTask(legacyTask.id)!;
    migrated.state = "cancelled";
    store.saveTask(migrated, "cancelled");
    expect(store.getTask(legacyTask.id)?.state).toBe("cancelled");
    store.close();
  });

  test("migrates an old-shape database to the full schema, ledger and retry backfill", () => {
    const { db } = paths();
    const failedAt = "2026-07-30T12:30:00.000Z";
    const old = new Database(db, { create: true });
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profiles(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL,
        default_model TEXT NOT NULL, enabled INTEGER NOT NULL, env_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, command_json TEXT, created_at TEXT, updated_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE tasks(
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), model TEXT NOT NULL,
        prompt TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL, output TEXT NOT NULL,
        error TEXT, question TEXT, parent_task_id TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE profile_failures(
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id), code TEXT NOT NULL,
        message TEXT NOT NULL, failed_at TEXT NOT NULL, consecutive_failures INTEGER NOT NULL
      );
      CREATE TABLE scope_grants(
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 1
      );
    `);
    old.query(`
      INSERT INTO profiles(
        id, label, provider, default_model, enabled, env_json, capabilities_json,
        command_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, '{}', '[]', NULL, ?, ?)
    `).run(profile.id, profile.label, profile.provider, profile.model, new Date().toISOString(), new Date().toISOString());
    const legacyTask = task("completed");
    old.query(`
      INSERT INTO tasks(
        id, profile_id, model, prompt, cwd, state, output, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyTask.id, legacyTask.profileId, legacyTask.model, legacyTask.prompt,
      legacyTask.cwd, legacyTask.state, legacyTask.output, legacyTask.createdAt, legacyTask.updatedAt,
    );
    old.query(`
      INSERT INTO profile_failures(profile_id, code, message, failed_at, consecutive_failures)
      VALUES (?, 'rate_limit', 'Too many requests', ?, 2)
    `).run(profile.id, failedAt);
    old.query(`
      INSERT INTO scope_grants(id, cwd, scope_json, created_at, last_used_at, use_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run("grant-1", "/tmp/project", JSON.stringify({ read: ["src/**"], write: [] }), failedAt, failedAt);
    old.close();

    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.close();

    const migrated = new Database(db);
    const ledger = migrated.query<{ version: number; name: string }, []>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ).all();
    expect(ledger).toEqual([
      { version: 1, name: "profiles tasks and events" },
      { version: 2, name: "task scope lifecycle and completion" },
      { version: 3, name: "profile failure retry timestamps" },
      { version: 4, name: "task worker session ids" },
      { version: 5, name: "backfill task worker session ids" },
      { version: 6, name: "project memories" },
      { version: 7, name: "task archives" },
      { version: 8, name: "scope grants, shipped prompts, attempts and cost" },
      { version: 9, name: "task titles" },
      { version: 10, name: "task worker identity" },
      { version: 11, name: "task selection records" },
      { version: 12, name: "profile failure network code" },
      { version: 13, name: "task token usage" },
      { version: 14, name: "project context maps" },
      { version: 15, name: "task holds" },
      { version: 16, name: "task follow-up queue" },
      { version: 17, name: "task actual reasoning effort" },
      { version: 18, name: "profile failures keyed per model" },
      { version: 19, name: "task git worktrees" },
    ]);
    const taskColumns = new Set(migrated.query<{ name: string }, []>(
      "PRAGMA table_info(tasks)",
    ).all().map(({ name }) => name));
    for (const column of [
      "scope_json", "allow_questions", "session_id", "archived_at", "grant_id",
      "shipped_prompt", "attempts_json", "cost_usd", "turns", "tokens_in", "tokens_out",
      "effort", "tldr", "title", "selection_json",
    ]) {
      expect(taskColumns).toContain(column);
    }
    expect(taskColumns).not.toContain("child_task_id");
    // The contract rebuild gave the legacy row the modern defaults.
    expect(migrated.query<{ scope_json: string; allow_questions: number }, [string]>(
      "SELECT scope_json, allow_questions FROM tasks WHERE id = ?",
    ).get(legacyTask.id)).toEqual({
      scope_json: '{"read":["**"],"write":["**"]}',
      allow_questions: 1,
    });
    // The rate-limit failure gained a retry time derived from its failed_at.
    expect(migrated.query<{ retry_at: string | null }, [string]>(
      "SELECT retry_at FROM profile_failures WHERE profile_id = ?",
    ).get(profile.id)?.retry_at).toBe(new Date(Date.parse(failedAt) + 10 * 60_000).toISOString());
    // The legacy grant gained the per-destination column and kept its row.
    const grantColumns = new Set(migrated.query<{ name: string }, []>(
      "PRAGMA table_info(scope_grants)",
    ).all().map(({ name }) => name));
    expect(grantColumns).toContain("profile_id");
    expect(migrated.query<{ id: string }, []>("SELECT id FROM scope_grants").all()
      .map(({ id }) => id)).toEqual(["grant-1"]);
    // The profiles rebuild widened the provider CHECK to pi and kept the row.
    expect(migrated.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    ).get()?.sql).toContain("'pi'");
    expect(migrated.query<{ id: string }, []>("SELECT id FROM profiles").all()
      .map(({ id }) => id)).toContain(profile.id);
    migrated.close();
  });

  test("observe open of a nonexistent path throws and creates nothing", () => {
    const { root } = paths();
    const missing = join(root, "nowhere", "inter.db");
    const message = errorMessage(() => new StateStore({ path: missing, observe: true }));
    expect(message).toContain(missing);
    expect(message).toContain("no database at this path");
    // The point of the check: a mistyped path must not materialise a database,
    // and neither the file nor its directory may appear afterwards.
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("observe open never writes migrations or the file it reads", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task("queued");
    store.createTask(saved);
    store.close();

    const raw = new Database(db);
    const before = raw.query<{ version: number }, []>(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all();
    raw.close();
    const mtimeBefore = statSync(db).mtimeMs;

    const observer = new StateStore({ path: db, observe: true });
    expect(observer.getTask(saved.id)).toMatchObject({ id: saved.id, state: "queued" });
    observer.close();

    // Reading through the observe handle left the ledger and the file untouched.
    expect(statSync(db).mtimeMs).toBe(mtimeBefore);
    const rawAfter = new Database(db);
    const after = rawAfter.query<{ version: number }, []>(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all();
    rawAfter.close();
    expect(after).toEqual(before);
  });

  test("observe open of a schema newer than the binary names the path and the mismatch", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.close();
    const raw = new Database(db);
    raw.exec("INSERT INTO schema_migrations(version, name) VALUES (999, 'schema from the future')");
    raw.close();

    const message = errorMessage(() => new StateStore({ path: db, observe: true }));
    expect(message).toContain(db);
    expect(message).toContain("newer than this binary knows");
    expect(message).toContain("v999");
  });

  test("observe open of a schema behind the binary names the mismatch too", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    store.close();
    const raw = new Database(db);
    raw.exec(`DELETE FROM schema_migrations WHERE version = ${LATEST_SCHEMA_VERSION}`);
    raw.close();

    // A behind schema is only readable after a migration, which observe mode
    // must never run, so the watcher says so instead of guessing at columns.
    const message = errorMessage(() => new StateStore({ path: db, observe: true }));
    expect(message).toContain(db);
    expect(message).toContain("predates this binary");
  });

  test("observe open of a file that is not an inter database names the path", () => {
    const { db } = paths();
    const raw = new Database(db);
    raw.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    raw.close();

    const message = errorMessage(() => new StateStore({ path: db, observe: true }));
    expect(message).toContain(db);
    expect(message).toContain("no schema_migrations table");
  });

  test("observe open of a healthy database still reads tasks", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const saved = task("running");
    store.createTask(saved);
    store.close();

    const observer = new StateStore({ path: db, observe: true });
    expect(observer.getTask(saved.id)).toMatchObject({ id: saved.id, state: "running" });
    expect(observer.inFlightTasks()).toEqual([{ id: saved.id, state: "running" }]);
    observer.close();
  });
});
