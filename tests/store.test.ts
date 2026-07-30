import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return { root, db: join(root, "inter.db"), legacy: join(root, "inter.config.json") };
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
  test("imports legacy profiles once and preserves deliberate deletion", () => {
    const { db, legacy } = paths();
    writeFileSync(legacy, JSON.stringify({ profiles: [profile] }));
    const first = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [] });
    expect(first.listProfiles()).toEqual([profile]);
    first.saveProfiles([]);
    first.close();

    const reopened = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [] });
    expect(reopened.listProfiles()).toEqual([]);
    reopened.close();
  });

  test("persists terminal tasks and ordered lifecycle events", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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

    const reopened = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
    expect(reopened.getTask(saved.id)?.output).toBe("done");
    expect(reopened.getTask(saved.id)?.state).toBe("completed");
    reopened.close();
  });

  test("lists no tasks when empty and orders tasks by latest update", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
    const interrupted = task("running");
    store.createTask(interrupted);
    store.close();

    const reopened = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
    expect(reopened.getTask(interrupted.id)?.state).toBe("failed");
    expect(reopened.listTaskEvents(interrupted.id).map(({ type }) => type))
      .toEqual(["created", "broker_restarted"]);
    reopened.close();
  });

  test("soft-deletes profiles without losing task history", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
    const saved = task("completed");
    store.createTask(saved);
    store.saveProfiles([]);
    expect(store.listProfiles()).toEqual([]);
    expect(store.getTask(saved.id)?.profileId).toBe(profile.id);
    store.close();
  });

  test("persists dynamic profile tool setting", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [] });
    expect(store.getSettings().dynamicProfileTools).toBe(false);
    store.saveSettings({ dynamicProfileTools: true });
    store.close();

    const reopened = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [] });
    expect(reopened.getSettings().dynamicProfileTools).toBe(true);
    reopened.close();
  });

  test("returns filtered summaries without full prompts or outputs", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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

  test("atomically marks a question answered and links its continuation", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
    const parent = task("needs_input");
    parent.question = "Which file?";
    store.createTask(parent);
    const child = task();
    child.parentTaskId = parent.id;
    store.createContinuation(parent.id, child);
    expect(store.getTask(parent.id)).toMatchObject({
      state: "answered",
      childTaskId: child.id,
    });
    expect(store.getTask(child.id)?.parentTaskId).toBe(parent.id);
    expect(() => store.createContinuation(parent.id, { ...task(), parentTaskId: parent.id }))
      .toThrow("does not need input");
    store.close();
  });

  test("records and clears routable profile failures", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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

  test("does not let worker completion overwrite cancellation", () => {
    const { db, legacy } = paths();
    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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
    const { db, legacy } = paths();
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

    const store = new StateStore({ path: db, legacyConfigPath: legacy, seedProfiles: [profile] });
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
