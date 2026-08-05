import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { StateStore } from "../src/store";
import {
  cutoffFor,
  deletedReport,
  parseCleanupArgs,
  previewReport,
  scheduledCleanupDays,
} from "../src/cleanup";
import type { Profile, Task, TaskState } from "../src/types";

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
  env: {},
  capabilities: ["build"],
};

function open() {
  const root = mkdtempSync(join(tmpdir(), "inter-cleanup-"));
  roots.push(root);
  const path = join(root, "inter.db");
  const store = new StateStore({ path, seedProfiles: [profile] });
  return { store, path };
}

interface SeedOptions {
  state?: TaskState;
  archived?: boolean;
  ageDays?: number;
  parent?: string;
  events?: number;
}

/**
 * A task as it would look after the given number of days. Archiving stamps
 * `updated_at`, so the backdating has to happen after it or every archived task
 * looks like it changed today.
 */
function seed(store: StateStore, path: string, options: SeedOptions = {}): string {
  const { state = "completed", archived = true, ageDays = 90, parent, events = 3 } = options;
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: profile.id,
    model: "sonnet",
    prompt: "do the thing",
    cwd: "/tmp/project",
    state,
    output: "done",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
    ...(parent ? { parentTaskId: parent } : {}),
  };
  store.createTask(task);
  for (let index = 0; index < events; index += 1) {
    store.appendTaskEvent(task.id, "agent.tool_use", state, { index, blob: "x".repeat(100) });
  }
  const raw = new Database(path);
  raw.query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(archived ? cutoffFor(ageDays) : null, cutoffFor(ageDays), task.id);
  raw.close();
  return task.id;
}

function eventCount(path: string, taskId: string): number {
  const raw = new Database(path);
  const row = raw.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?",
  ).get(taskId)!;
  raw.close();
  return row.count;
}

/** Every state that means the work is still moving or still waiting on a person. */
const LIVE_STATES: TaskState[] = ["queued", "running", "needs_input", "answered", "blocked"];

describe("cleanup eligibility", () => {
  test("preview counts are exactly what execution removes", () => {
    const { store, path } = open();
    const ids = [seed(store, path), seed(store, path, { state: "failed" })];
    const cutoff = cutoffFor(30);

    const plan = store.cleanupPlan(cutoff);
    expect(plan.tasks).toBe(2);
    expect(plan.events).toBe(eventCount(path, ids[0]!) + eventCount(path, ids[1]!));
    expect(plan.bytes).toBeGreaterThan(0);

    const result = store.deleteSettledTaskActivity(cutoff);
    expect(result.tasks).toBe(plan.tasks);
    expect(result.events).toBe(plan.events);
    expect(result.bytes).toBe(plan.bytes);
    for (const id of ids) expect(eventCount(path, id)).toBe(0);
    store.close();
  });

  test("keeps every task row and its result, deleting only the activity", () => {
    const { store, path } = open();
    const id = seed(store, path);
    store.deleteSettledTaskActivity(cutoffFor(30));

    const task = store.getTask(id);
    expect(task?.output).toBe("done");
    expect(task?.prompt).toBe("do the thing");
    expect(store.listTasks(200, "include").map(({ id: taskId }) => taskId)).toContain(id);
    store.close();
  });

  test("never deletes work that is running or waiting, however old", () => {
    const { store, path } = open();
    const live = LIVE_STATES.map((state) => seed(store, path, { state, ageDays: 900 }));

    expect(store.cleanupPlan(cutoffFor(1)).tasks).toBe(0);
    const result = store.deleteSettledTaskActivity(cutoffFor(1));
    expect(result.events).toBe(0);
    for (const id of live) expect(eventCount(path, id)).toBeGreaterThan(0);
    store.close();
  });

  test("never deletes work that has not been archived", () => {
    const { store, path } = open();
    const id = seed(store, path, { archived: false, ageDays: 900 });

    expect(store.cleanupPlan(cutoffFor(1)).tasks).toBe(0);
    store.deleteSettledTaskActivity(cutoffFor(1));
    expect(eventCount(path, id)).toBeGreaterThan(0);
    store.close();
  });

  test("never deletes work younger than the retention", () => {
    const { store, path } = open();
    const id = seed(store, path, { ageDays: 5 });

    expect(store.cleanupPlan(cutoffFor(30)).tasks).toBe(0);
    store.deleteSettledTaskActivity(cutoffFor(30));
    expect(eventCount(path, id)).toBeGreaterThan(0);
    store.close();
  });

  test("holds a fan-out parent back while a task under it is unfinished", () => {
    const { store, path } = open();
    const parent = seed(store, path);
    const child = seed(store, path, { state: "running", parent });

    const plan = store.cleanupPlan(cutoffFor(30));
    expect(plan.tasks).toBe(0);
    expect(plan.heldBack).toBe(1);

    store.deleteSettledTaskActivity(cutoffFor(30));
    expect(eventCount(path, parent)).toBeGreaterThan(0);
    expect(eventCount(path, child)).toBeGreaterThan(0);
    store.close();
  });

  test("deletes a fan-out once every task under it is eligible too", () => {
    const { store, path } = open();
    const parent = seed(store, path);
    const child = seed(store, path, { state: "failed", parent });

    const plan = store.cleanupPlan(cutoffFor(30));
    expect(plan.tasks).toBe(2);
    expect(plan.heldBack).toBe(0);

    store.deleteSettledTaskActivity(cutoffFor(30));
    expect(eventCount(path, parent)).toBe(0);
    expect(eventCount(path, child)).toBe(0);
    store.close();
  });

  test("an empty eligible set is a clean no-op", () => {
    const { store, path } = open();
    seed(store, path, { ageDays: 2 });

    const result = store.deleteSettledTaskActivity(cutoffFor(30));
    expect(result.tasks).toBe(0);
    expect(result.events).toBe(0);
    expect(result.byState).toEqual([]);
    // Nothing was removed, so nothing was rewritten and nothing was reclaimed.
    expect(result.fileBytesAfter).toBeGreaterThanOrEqual(result.fileBytesBefore);
    expect(store.lastCleanup()).toBeUndefined();
    store.close();
  });

  test("reclaims the file, not just the rows", () => {
    const { store, path } = open();
    for (let index = 0; index < 40; index += 1) {
      const id = seed(store, path, { events: 0 });
      const raw = new Database(path);
      for (let event = 0; event < 40; event += 1) {
        raw.query("INSERT INTO task_events(task_id, event_type, state, payload) VALUES (?, ?, ?, ?)")
          .run(id, "agent.hook", "completed", JSON.stringify({ blob: "y".repeat(4_000) }));
      }
      raw.close();
    }

    // 40 tasks, each with the row `createTask` writes plus 40 fat ones.
    const result = store.deleteSettledTaskActivity(cutoffFor(30));
    expect(result.events).toBe(40 * 41);
    expect(result.fileBytesAfter).toBeLessThan(result.fileBytesBefore);
    store.close();
  });

  test("leaves memories, grants and profiles alone", () => {
    const { store, path } = open();
    seed(store, path);
    store.setMemory("/tmp/project", "convention", "always run the linter");
    const grant = store.recordScopeGrant("/tmp/project", profile.id, { read: ["**"], write: ["src/**"] });

    store.deleteSettledTaskActivity(cutoffFor(30));

    expect(store.getMemory("/tmp/project", "convention")?.value).toBe("always run the linter");
    expect(store.listMemoryProjects()).toHaveLength(1);
    expect(store.getScopeGrant(grant.id)).toBeDefined();
    expect(store.listProfiles().map(({ id }) => id)).toContain(profile.id);
    store.close();
  });

  test("records what the last run removed", () => {
    const { store, path } = open();
    seed(store, path);
    const result = store.deleteSettledTaskActivity(cutoffFor(30));

    const last = store.lastCleanup();
    expect(last?.events).toBe(result.events);
    expect(last?.tasks).toBe(1);
    expect(last?.finishedAt).toBe(result.finishedAt);
    store.close();
  });

  test("cascade is what deleting a task row would do, and cleanup never does it", () => {
    const { store, path } = open();
    const id = seed(store, path);
    store.deleteSettledTaskActivity(cutoffFor(30));
    expect(store.getTask(id)).toBeDefined();

    // The foreign key is the reason cleanup can stay in one statement: were a
    // task row ever removed, its activity would go with it silently.
    const raw = new Database(path);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.query("INSERT INTO task_events(task_id, event_type, state, payload) VALUES (?, ?, ?, ?)")
      .run(id, "agent.hook", "completed", "{}");
    expect(raw.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?",
    ).get(id)!.count).toBe(1);
    raw.query("DELETE FROM tasks WHERE id = ?").run(id);
    expect(raw.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?",
    ).get(id)!.count).toBe(0);
    raw.close();
    store.close();
  });

  test("maintenance opens do not settle the tasks a live broker is driving", () => {
    const { store, path } = open();
    const id = seed(store, path, { state: "running", archived: false, ageDays: 900 });

    const maintenance = new StateStore({ path, maintenance: true });
    maintenance.deleteSettledTaskActivity(cutoffFor(1));
    expect(maintenance.getTask(id)?.state).toBe("running");
    maintenance.close();

    expect(store.getTask(id)?.state).toBe("running");
    store.close();
  });

  test("refuses to open a database that is not there", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-cleanup-"));
    roots.push(root);
    expect(() => new StateStore({ path: join(root, "missing.db"), maintenance: true }))
      .toThrow(/no database at/);
  });
});

describe("cleanup command", () => {
  test("previews at the default retention when nothing is asked for", () => {
    expect(parseCleanupArgs([])).toEqual({ olderThanDays: 30, execute: false, chosenDays: false });
  });

  test("deleting requires a retention the caller typed", () => {
    expect(parseCleanupArgs(["--delete"])).toEqual({
      error: "--delete needs --older-than <days>, so the retention is one you chose",
    });
    expect(parseCleanupArgs(["--older-than", "14", "--delete"]))
      .toEqual({ olderThanDays: 14, execute: true, chosenDays: true });
    expect(parseCleanupArgs(["--older-than=14d", "--delete"]))
      .toEqual({ olderThanDays: 14, execute: true, chosenDays: true });
  });

  test("rejects retentions that are not a usable number of days", () => {
    for (const value of ["0", "-1", "abc", "5000", "1.5"]) {
      expect(parseCleanupArgs(["--older-than", value])).toHaveProperty("error");
    }
    expect(parseCleanupArgs(["--older-than"])).toEqual({ error: "--older-than needs a value" });
    expect(parseCleanupArgs(["--force"])).toEqual({ error: "unknown option: --force" });
  });

  test("the preview says nothing was deleted and what would survive", () => {
    const { store, path } = open();
    seed(store, path);
    seed(store, path, { state: "failed" });
    const text = previewReport(
      store.cleanupPlan(cutoffFor(30)),
      { olderThanDays: 30, chosenDays: true },
    );
    store.close();

    expect(text).toContain("Nothing has been deleted");
    expect(text).toContain("2 tasks");
    expect(text).toContain("1 completed · 1 failed");
    expect(text).toContain("inter cleanup --older-than 30d --delete");
    expect(text).toContain("Project memories are never touched");
    // The preview is read by someone deciding whether to destroy their own
    // data; the schema's names for things are no help to them.
    expect(text).not.toMatch(/archived_at|task_events|updated_at|VACUUM/);
  });

  test("offers no delete once the eligible tasks have no activity left", () => {
    const { store, path } = open();
    seed(store, path);
    store.deleteSettledTaskActivity(cutoffFor(30));

    // The tasks are still eligible; a second pass would just find them empty.
    const plan = store.cleanupPlan(cutoffFor(30));
    expect(plan.tasks).toBe(1);
    expect(plan.events).toBe(0);

    const text = previewReport(plan, { olderThanDays: 30, chosenDays: true }, store.lastCleanup());
    store.close();
    expect(text).toContain("no activity left to delete");
    expect(text).not.toContain("--delete");
    expect(text).toContain("Last cleanup");
  });

  test("the report names the counts and the space actually reclaimed", () => {
    const { store, path } = open();
    seed(store, path);
    const text = deletedReport(store.deleteSettledTaskActivity(cutoffFor(30)), 30);
    store.close();

    expect(text).toContain("Deleted the activity of 1 task:");
    expect(text).toContain("Database file");
    expect(text).not.toMatch(/archived_at|task_events|VACUUM/);
  });

  test("an empty run says so instead of printing zeroes", () => {
    const { store, path } = open();
    seed(store, path, { ageDays: 2 });
    const text = deletedReport(store.deleteSettledTaskActivity(cutoffFor(30)), 30);
    store.close();
    expect(text).toBe(
      "Nothing was deleted. No task has finished, been archived, and gone untouched for 30 days.",
    );
  });
});

describe("automatic cleanup", () => {
  test("is off unless a retention is configured", () => {
    expect(scheduledCleanupDays({})).toBeUndefined();
    expect(scheduledCleanupDays({ INTER_CLEANUP_DAYS: "" })).toBeUndefined();
    expect(scheduledCleanupDays({ INTER_CLEANUP_DAYS: "45" })).toBe(45);
  });

  test("refuses a retention it cannot honour rather than ignoring it", () => {
    expect(() => scheduledCleanupDays({ INTER_CLEANUP_DAYS: "soon" }))
      .toThrow(/whole number of days/);
    expect(() => scheduledCleanupDays({ INTER_CLEANUP_DAYS: "0" }))
      .toThrow(/whole number of days/);
  });
});
