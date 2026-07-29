import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
