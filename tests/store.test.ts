import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { StateStore } from "../src/store";
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

describe("SQLite state store", () => {
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
    expect(store.replaceTaskSessionId(saved.id, "claude", "stale", "sess-456")).toBe(false);
    expect(store.replaceTaskSessionId(saved.id, "claude", "sess-123", "sess-456")).toBe(true);
    expect(store.getTask(saved.id)?.sessionId).toBe("sess-456");
    expect(store.listTaskSummaries()[0]?.sessionId).toBe("sess-456");
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
      ["claude-work", { session_id: 12 }, { session_id: "claude-first" }, { session_id: "claude-later" }],
      ["codex", { thread_id: null }, { thread_id: "codex-first" }, { thread_id: "codex-later" }],
      ["opencode", { sessionID: {} }, { sessionID: "opencode-first" }, { sessionID: "opencode-later" }],
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

  test("persists dynamic profile tool setting", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [] });
    expect(store.getSettings().dynamicProfileTools).toBe(false);
    store.saveSettings({ dynamicProfileTools: true });
    store.close();

    const reopened = new StateStore({ path: db, seedProfiles: [] });
    expect(reopened.getSettings().dynamicProfileTools).toBe(true);
    reopened.close();
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

  test("lists meaningful events for several tasks and latest heartbeat progress", () => {
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
    expect(store.listTaskEventsForTasks([first.id, second.id], cursor, 10, true)
      .map(({ type }) => type)).toEqual(["heartbeat"]);
    expect(store.latestTaskProgress([first.id, second.id])[second.id]).toMatchObject({
      elapsedMs: 10_000,
      silentMs: 4_000,
      stalled: false,
    });
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

  test("links one resumption without changing the failed parent state", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    const parent = task("failed");
    store.createTask(parent);
    const child = task();
    child.parentTaskId = parent.id;
    store.createResumption(parent.id, child);
    expect(store.getTask(parent.id)).toMatchObject({
      state: "failed",
      childTaskId: child.id,
    });
    expect(store.getTask(child.id)?.parentTaskId).toBe(parent.id);
    expect(() => store.createResumption(parent.id, { ...task(), parentTaskId: parent.id }))
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
});
