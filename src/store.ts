import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type {
  BrokerSettings,
  Profile,
  Task,
  TaskCompletion,
  TaskState,
  TaskSummary,
} from "./types";

interface ProfileRow {
  id: string;
  label: string;
  provider: Profile["provider"];
  default_model: string;
  enabled: number;
  env_json: string;
  capabilities_json: string;
  command_json: string | null;
}

interface TaskRow {
  id: string;
  profile_id: string;
  model: string;
  prompt: string;
  cwd: string;
  state: TaskState;
  output: string;
  error: string | null;
  question: string | null;
  parent_task_id: string | null;
  child_task_id: string | null;
  scope_json: string;
  allow_questions: number;
  timeout_ms: number | null;
  completion_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  state: TaskState;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StateStoreOptions {
  path?: string;
  legacyConfigPath?: string;
  seedProfiles?: Profile[];
}

export interface TaskListQuery {
  limit?: number;
  state?: TaskState;
  since?: string;
  profile?: string;
}

export interface ProfileFailure {
  profileId: string;
  code: "auth" | "billing" | "rate_limit";
  message: string;
  failedAt: string;
  consecutiveFailures: number;
}

export class StateStore {
  readonly path: string;
  private readonly database: Database;

  constructor(options: StateStoreOptions = {}) {
    this.path = resolve(options.path ?? databasePath());
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new Database(this.path, { create: true, strict: true });
    try { chmodSync(this.path, 0o600); } catch {}
    this.configure();
    this.migrate();
    this.seed(options.legacyConfigPath ?? legacyConfigPath(), options.seedProfiles ?? defaultProfiles());
    this.recoverInterruptedTasks();
  }

  close(): void {
    this.database.exec("PRAGMA optimize");
    this.database.close();
  }

  listProfiles(): Profile[] {
    return this.database.query<ProfileRow, []>(`
      SELECT id, label, provider, default_model, enabled, env_json, capabilities_json, command_json
      FROM profiles
      WHERE deleted_at IS NULL
      ORDER BY created_at, id
    `).all().map(profileFromRow);
  }

  saveProfiles(profiles: Profile[]): void {
    const ids = new Set(profiles.map(({ id }) => id));
    this.transaction(() => {
      const upsert = this.database.query(`
        INSERT INTO profiles(
          id, label, provider, default_model, enabled, env_json, capabilities_json, command_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          provider = excluded.provider,
          default_model = excluded.default_model,
          enabled = excluded.enabled,
          env_json = excluded.env_json,
          capabilities_json = excluded.capabilities_json,
          command_json = excluded.command_json,
          deleted_at = NULL,
          updated_at = excluded.updated_at
      `);
      for (const profile of profiles) {
        upsert.run(
          profile.id,
          profile.label,
          profile.provider,
          profile.model,
          profile.enabled ? 1 : 0,
          JSON.stringify(profile.env),
          JSON.stringify(profile.capabilities),
          profile.command ? JSON.stringify(profile.command) : null,
        );
      }
      for (const row of this.database.query<{ id: string }, []>("SELECT id FROM profiles").all()) {
        if (!ids.has(row.id)) {
          this.database.query(`
            UPDATE profiles
            SET deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
          `).run(row.id);
        }
      }
    });
  }

  getSettings(): BrokerSettings {
    return {
      dynamicProfileTools: this.getSetting("dynamic_profile_tools") === "1",
    };
  }

  saveSettings(settings: BrokerSettings): void {
    this.database.query(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run("dynamic_profile_tools", settings.dynamicProfileTools ? "1" : "0");
  }

  createTask(task: Task): void {
    this.database.query(`
      INSERT INTO tasks(
        id, profile_id, model, prompt, cwd, state, output, error, question,
        parent_task_id, child_task_id, scope_json, allow_questions, timeout_ms,
        completion_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.profileId, task.model, task.prompt, task.cwd, task.state,
      task.output, task.error ?? null, task.question ?? null, task.parentTaskId ?? null,
      task.childTaskId ?? null, JSON.stringify(task.scope), task.allowQuestions ? 1 : 0,
      task.timeoutMs ?? null, task.completion ? JSON.stringify(task.completion) : null,
      task.createdAt, task.updatedAt,
    );
    this.addTaskEvent(task.id, "created", task.state, {});
  }

  saveTask(
    task: Task,
    eventType = "state_changed",
    payload: Record<string, unknown> = {},
    expectedStates: TaskState[] = [],
  ): boolean {
    let saved = false;
    this.transaction(() => {
      const expected = expectedStates.length
        ? `AND state IN (${expectedStates.map(() => "?").join(",")})`
        : "";
      const changed = this.database.query<unknown, Array<string | number | null>>(`
        UPDATE tasks SET
          state = ?, output = ?, error = ?, question = ?, child_task_id = ?,
          completion_json = ?, updated_at = ?
        WHERE id = ? ${expected}
      `).run(
        task.state, task.output, task.error ?? null, task.question ?? null, task.childTaskId ?? null,
        task.completion ? JSON.stringify(task.completion) : null,
        task.updatedAt, task.id, ...expectedStates,
      );
      if (changed.changes !== 1) return;
      this.addTaskEvent(task.id, eventType, task.state, payload);
      saved = true;
    });
    return saved;
  }

  cancelTask(
    id: string,
    reason: string,
    completion: TaskCompletion,
  ): Task | undefined {
    const now = new Date().toISOString();
    let cancelled = false;
    this.transaction(() => {
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'cancelled', error = ?, completion_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'running')
      `).run(reason, JSON.stringify(completion), now, id);
      if (changed.changes !== 1) return;
      this.addTaskEvent(id, "cancelled", "cancelled", { error: reason, completion });
      cancelled = true;
    });
    return cancelled ? this.getTask(id) : undefined;
  }

  createContinuation(parentId: string, child: Task): void {
    this.transaction(() => {
      this.createTask(child);
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'answered', child_task_id = ?, updated_at = ?
        WHERE id = ? AND state = 'needs_input'
      `).run(child.id, child.createdAt, parentId);
      if (changed.changes !== 1) throw new Error(`task does not need input: ${parentId}`);
      this.addTaskEvent(parentId, "answered", "answered", { childTaskId: child.id });
    });
  }

  getTask(id: string): Task | undefined {
    const row = this.database.query<TaskRow, [string]>(`
      SELECT id, profile_id, model, prompt, cwd, state, output, error, question,
             parent_task_id, child_task_id, scope_json, allow_questions, timeout_ms,
             completion_json, created_at, updated_at
      FROM tasks WHERE id = ?
    `).get(id);
    return row ? taskFromRow(row) : undefined;
  }

  listTasks(limit = 200): Task[] {
    return this.database.query<TaskRow, [number]>(`
      SELECT id, profile_id, model, prompt, cwd, state, output, error, question,
             parent_task_id, child_task_id, scope_json, allow_questions, timeout_ms,
             completion_json, created_at, updated_at
      FROM tasks
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(limit).map(taskFromRow);
  }

  listTaskSummaries(query: TaskListQuery = {}): TaskSummary[] {
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.state) {
      clauses.push("state = ?");
      values.push(query.state);
    }
    if (query.since) {
      clauses.push("updated_at >= ?");
      values.push(query.since);
    }
    if (query.profile) {
      clauses.push("profile_id = ?");
      values.push(query.profile);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.query<TaskRow, Array<string | number>>(`
      SELECT id, profile_id, model, prompt, cwd, state, output, error, question,
             parent_task_id, child_task_id, scope_json, allow_questions, timeout_ms,
             completion_json, created_at, updated_at
      FROM tasks
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...values, limit);
    return rows.map(taskSummaryFromRow);
  }

  listTaskEvents(taskId: string, afterId = 0, limit = 5_001): TaskEvent[] {
    const rows = this.database.query<{
      id: number;
      task_id: string;
      event_type: string;
      state: TaskState;
      payload: string;
      created_at: string;
    }, [string, number, number]>(`
      SELECT id, task_id, event_type, state, payload, created_at
      FROM task_events
      WHERE task_id = ? AND id > ?
      ORDER BY id
      LIMIT ?
    `).all(taskId, afterId, limit);
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      type: row.event_type,
      state: row.state,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  listTaskEventsForTasks(
    taskIds: string[],
    afterId = 0,
    limit = 101,
    meaningfulOnly = false,
  ): TaskEvent[] {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => "?").join(",");
    const meaningful = meaningfulOnly ? "AND event_type != 'agent.system'" : "";
    const rows = this.database.query<{
      id: number;
      task_id: string;
      event_type: string;
      state: TaskState;
      payload: string;
      created_at: string;
    }, Array<string | number>>(`
      SELECT id, task_id, event_type, state, payload, created_at
      FROM task_events
      WHERE task_id IN (${placeholders}) AND id > ? ${meaningful}
      ORDER BY id
      LIMIT ?
    `).all(...taskIds, afterId, limit);
    return rows.map(taskEventFromRow);
  }

  appendTaskEvent(taskId: string, type: string, state: TaskState, payload: Record<string, unknown>): void {
    this.addTaskEvent(taskId, type, state, payload);
  }

  latestTaskEventId(taskIds: string[], meaningfulOnly = false): number {
    let latest = 0;
    const query = this.database.query<{ id: number | null }, [string]>(
      `SELECT MAX(id) AS id FROM task_events WHERE task_id = ? ${
        meaningfulOnly ? "AND event_type != 'agent.system'" : ""
      }`,
    );
    for (const taskId of taskIds) latest = Math.max(latest, query.get(taskId)?.id ?? 0);
    return latest;
  }

  latestTaskProgress(taskIds: string[]): Record<string, {
    elapsedMs: number;
    silentMs: number;
    stalled: boolean;
    at: string;
  }> {
    const progress: Record<string, {
      elapsedMs: number;
      silentMs: number;
      stalled: boolean;
      at: string;
    }> = {};
    const query = this.database.query<{ payload: string; created_at: string }, [string]>(`
      SELECT payload, created_at
      FROM task_events
      WHERE task_id = ? AND event_type = 'heartbeat'
      ORDER BY id DESC
      LIMIT 1
    `);
    for (const taskId of taskIds) {
      const row = query.get(taskId);
      if (!row) continue;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      progress[taskId] = {
        elapsedMs: Number(payload.elapsedMs ?? 0),
        silentMs: Number(payload.silentMs ?? 0),
        stalled: payload.stalled === true,
        at: row.created_at,
      };
    }
    return progress;
  }

  recordProfileFailure(
    profileId: string,
    code: ProfileFailure["code"],
    message: string,
  ): void {
    this.database.query(`
      INSERT INTO profile_failures(profile_id, code, message, failed_at, consecutive_failures)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(profile_id) DO UPDATE SET
        code = excluded.code,
        message = excluded.message,
        failed_at = excluded.failed_at,
        consecutive_failures = profile_failures.consecutive_failures + 1
    `).run(profileId, code, message.slice(0, 1_000), new Date().toISOString());
  }

  clearProfileFailure(profileId: string): void {
    this.database.query("DELETE FROM profile_failures WHERE profile_id = ?").run(profileId);
  }

  listProfileFailures(): ProfileFailure[] {
    return this.database.query<{
      profile_id: string;
      code: ProfileFailure["code"];
      message: string;
      failed_at: string;
      consecutive_failures: number;
    }, []>(`
      SELECT profile_id, code, message, failed_at, consecutive_failures
      FROM profile_failures
    `).all().map((row) => ({
      profileId: row.profile_id,
      code: row.code,
      message: row.message,
      failedAt: row.failed_at,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  private configure(): void {
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  private getSetting(key: string): string | undefined {
    return this.database.query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    ).get(key)?.value;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
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
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'queued','running','needs_input','answered','blocked','completed','failed','cancelled'
        )),
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        question TEXT,
        parent_task_id TEXT REFERENCES tasks(id),
        child_task_id TEXT REFERENCES tasks(id),
        scope_json TEXT NOT NULL DEFAULT '{"read":["**"],"write":["**"]}' CHECK(json_valid(scope_json)),
        allow_questions INTEGER NOT NULL DEFAULT 1 CHECK(allow_questions IN (0,1)),
        timeout_ms INTEGER,
        completion_json TEXT CHECK(completion_json IS NULL OR json_valid(completion_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS tasks_profile_updated ON tasks(profile_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS task_events_task_id ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS profile_failures (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
        code TEXT NOT NULL CHECK(code IN ('auth','billing','rate_limit')),
        message TEXT NOT NULL,
        failed_at TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (1, 'profiles tasks and events');
    `);
    const columns = new Set(this.database.query<{ name: string }, []>(
      "PRAGMA table_info(tasks)",
    ).all().map(({ name }) => name));
    if (!columns.has("scope_json")) this.migrateTaskContract();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (2, 'task scope lifecycle and completion')
    `).run();
  }

  private migrateTaskContract(): void {
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_v2 (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id),
          model TEXT NOT NULL,
          prompt TEXT NOT NULL,
          cwd TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'queued','running','needs_input','answered','blocked','completed','failed','cancelled'
          )),
          output TEXT NOT NULL DEFAULT '',
          error TEXT,
          question TEXT,
          parent_task_id TEXT REFERENCES tasks(id),
          child_task_id TEXT REFERENCES tasks(id),
          scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
          allow_questions INTEGER NOT NULL CHECK(allow_questions IN (0,1)),
          timeout_ms INTEGER,
          completion_json TEXT CHECK(completion_json IS NULL OR json_valid(completion_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO tasks_v2(
          id, profile_id, model, prompt, cwd, state, output, error, question,
          parent_task_id, child_task_id, scope_json, allow_questions, timeout_ms,
          completion_json, created_at, updated_at
        )
        SELECT id, profile_id, model, prompt, cwd, state, output, error, question,
          parent_task_id, NULL, '{"read":["**"],"write":["**"]}', 1, NULL,
          NULL, created_at, updated_at
        FROM tasks;
        ALTER TABLE task_events RENAME TO task_events_v1;
        DROP INDEX IF EXISTS task_events_task_id;
        DROP TABLE tasks;
        ALTER TABLE tasks_v2 RENAME TO tasks;
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          state TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO task_events(id, task_id, event_type, state, payload, created_at)
        SELECT id, task_id, event_type, state, payload, created_at FROM task_events_v1;
        DROP TABLE task_events_v1;
        CREATE INDEX tasks_updated_at ON tasks(updated_at DESC, id DESC);
        CREATE INDEX tasks_profile_updated ON tasks(profile_id, updated_at DESC);
        CREATE INDEX task_events_task_id ON task_events(task_id, id);
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  private seed(configPath: string, defaults: Profile[]): void {
    const seeded = this.database.query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    ).get("profiles_initialized");
    if (seeded) return;

    let profiles = defaults;
    try {
      const legacy = JSON.parse(readFileSync(configPath, "utf8")) as { profiles?: Profile[] };
      if (Array.isArray(legacy.profiles)) profiles = legacy.profiles;
    } catch {}
    this.saveProfiles(profiles);
    this.database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run("profiles_initialized", "1");
  }

  private recoverInterruptedTasks(): void {
    const interrupted = this.database.query<{ id: string }, []>(
      "SELECT id FROM tasks WHERE state IN ('queued', 'running')",
    ).all();
    if (interrupted.length === 0) return;
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const { id } of interrupted) {
        this.database.query(`
          UPDATE tasks SET state = 'failed', error = 'Broker restarted before task completed', updated_at = ?
          WHERE id = ?
        `).run(now, id);
        this.addTaskEvent(id, "broker_restarted", "failed", {
          error: "Broker restarted before task completed",
        });
      }
    });
  }

  private addTaskEvent(taskId: string, type: string, state: TaskState, payload: Record<string, unknown>): void {
    this.database.query(`
      INSERT INTO task_events(task_id, event_type, state, payload)
      VALUES (?, ?, ?, ?)
    `).run(taskId, type, state, JSON.stringify(payload));
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

let sharedStore: StateStore | undefined;

export function stateStore(): StateStore {
  return sharedStore ??= new StateStore();
}

export function closeStateStore(): void {
  sharedStore?.close();
  sharedStore = undefined;
}

export function databasePath(): string {
  if (process.env.INTER_DB) return resolve(process.env.INTER_DB);
  const config = process.env.INTER_CONFIG;
  if (config) return join(dirname(resolve(config)), "inter.db");
  return join(homedir(), ".inter", "inter.db");
}

function legacyConfigPath(): string {
  return resolve(process.env.INTER_CONFIG ?? join(homedir(), ".inter", "inter.config.json"));
}

function profileFromRow(row: ProfileRow): Profile {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.default_model,
    enabled: row.enabled === 1,
    env: JSON.parse(row.env_json) as Record<string, string>,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    ...(row.command_json ? { command: JSON.parse(row.command_json) as string[] } : {}),
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    profileId: row.profile_id,
    model: row.model,
    prompt: row.prompt,
    cwd: row.cwd,
    state: row.state,
    output: row.output,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
    ...(row.question ? { question: row.question } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.child_task_id ? { childTaskId: row.child_task_id } : {}),
    scope: JSON.parse(row.scope_json) as Task["scope"],
    allowQuestions: row.allow_questions === 1,
    ...(row.timeout_ms ? { timeoutMs: row.timeout_ms } : {}),
    ...(row.completion_json
      ? { completion: JSON.parse(row.completion_json) as TaskCompletion }
      : {}),
  };
}

function taskSummaryFromRow(row: TaskRow): TaskSummary {
  const task = taskFromRow(row);
  return {
    id: task.id,
    profileId: task.profileId,
    model: task.model,
    cwd: task.cwd,
    state: task.state,
    promptPreview: task.prompt.replace(/\s+/g, " ").trim().slice(0, 240),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error.slice(0, 500) } : {}),
    ...(task.question ? { question: task.question } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.childTaskId ? { childTaskId: task.childTaskId } : {}),
    ...(task.completion ? { completion: task.completion } : {}),
  };
}

function taskEventFromRow(row: {
  id: number;
  task_id: string;
  event_type: string;
  state: TaskState;
  payload: string;
  created_at: string;
}): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.event_type,
    state: row.state,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function defaultProfiles(): Profile[] {
  return [
    {
      id: "claude-work",
      label: "Claude · work",
      provider: "claude",
      model: "sonnet",
      enabled: true,
      env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-work" },
      capabilities: ["build", "review"],
    },
    {
      id: "claude-isern",
      label: "Claude · isern",
      provider: "claude",
      model: "sonnet",
      enabled: true,
      env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-isern" },
      capabilities: ["build", "review"],
    },
  ];
}
