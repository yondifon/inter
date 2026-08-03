import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
