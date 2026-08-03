import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { discoverProfiles } from "./profile-discovery";
import { sessionIdFrom } from "./adapters";
import type {
  Profile,
  MemoryEntry,
  MemoryProject,
  ScopeGrant,
  Task,
  TaskAttempt,
  TaskCompletion,
  TaskState,
  TaskSummary,
  TaskScope,
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
  shipped_prompt: string | null;
  cwd: string;
  state: TaskState;
  output: string;
  error: string | null;
  question: string | null;
  parent_task_id: string | null;
  scope_json: string;
  grant_id: string | null;
  allow_questions: number;
  timeout_ms: number | null;
  effort: string | null;
  tldr: string | null;
  title: string | null;
  session_id: string | null;
  completion_json: string | null;
  attempts_json: string | null;
  cost_usd: number | null;
  turns: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const TASK_COLUMNS = `id, profile_id, model, prompt, shipped_prompt, cwd, state, output, error,
             question, parent_task_id, scope_json, grant_id, allow_questions, timeout_ms,
             effort, tldr, title, session_id, completion_json, attempts_json, cost_usd, turns, archived_at,
             created_at, updated_at`;

// Heartbeats fire every 10s regardless of worker activity, so counting them as
// progress would wake every caller on a fixed timer instead of on real news.
// The `progress` summary still carries elapsed/silent/stalled for the same tasks.
const NOISE_EVENTS = "('agent.system','heartbeat')";

// How many prior worker runs a task keeps. Enough to see how a task got where
// it is; bounded so a long reply/resume chain cannot grow the row without end.
const MAX_ATTEMPTS = 10;

const GRANT_COLUMNS = "id, cwd, profile_id, scope_json, created_at, last_used_at, use_count";

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
  seedProfiles?: Profile[];
}

export interface TaskListQuery {
  limit?: number;
  state?: TaskState;
  since?: string;
  profile?: string;
  parent?: string;
  archived?: "active" | "only" | "include";
}

export interface ProfileFailure {
  profileId: string;
  code: "auth" | "billing" | "rate_limit";
  message: string;
  failedAt: string;
  consecutiveFailures: number;
  retryAt?: string;
}

export interface ProfileSuccess {
  profileId: string;
  succeededAt: string;
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
    // Passed as a thunk: seeding happens once, but the argument would be
    // evaluated on every start, and discovery reads the home directory.
    this.seed(() => options.seedProfiles ?? discoverProfiles());
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

  /**
   * Records the scope a caller stated for a cwd so a later delegation that
   * omits scope reuses what was already approved instead of falling back to
   * whole-tree access. Re-stating the same scope refreshes the existing grant.
   */
  recordScopeGrant(cwd: string, profileId: string, scope: TaskScope): ScopeGrant {
    const project = resolve(cwd);
    const scopeJson = JSON.stringify(scope);
    const now = new Date().toISOString();
    const existing = this.database.query<{ id: string }, [string, string, string]>(
      "SELECT id FROM scope_grants WHERE cwd = ? AND profile_id = ? AND scope_json = ?",
    ).get(project, profileId, scopeJson);
    if (existing) {
      this.database.query(`
        UPDATE scope_grants
        SET last_used_at = ?, use_count = use_count + 1
        WHERE id = ?
      `).run(now, existing.id);
      return this.getScopeGrant(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO scope_grants(id, cwd, profile_id, scope_json, created_at, last_used_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(id, project, profileId, scopeJson, now, now);
    return this.getScopeGrant(id)!;
  }

  /**
   * The grant a delegation should inherit. A scope stated for this profile wins;
   * only when the profile has none of its own does a grant approved for some
   * other destination come back, so the caller can flag the reuse.
   */
  latestScopeGrant(cwd: string, profileId?: string): ScopeGrant | undefined {
    const project = resolve(cwd);
    if (profileId) {
      const own = this.database.query<ScopeGrantRow, [string, string]>(`
        SELECT ${GRANT_COLUMNS} FROM scope_grants WHERE cwd = ? AND profile_id = ?
        ORDER BY last_used_at DESC, id DESC LIMIT 1
      `).get(project, profileId);
      if (own) return scopeGrantFromRow(own);
    }
    const row = this.database.query<ScopeGrantRow, [string]>(`
      SELECT ${GRANT_COLUMNS} FROM scope_grants WHERE cwd = ?
      ORDER BY last_used_at DESC, id DESC LIMIT 1
    `).get(project);
    return row ? scopeGrantFromRow(row) : undefined;
  }

  getScopeGrant(id: string): ScopeGrant | undefined {
    const row = this.database.query<ScopeGrantRow, [string]>(
      `SELECT ${GRANT_COLUMNS} FROM scope_grants WHERE id = ?`,
    ).get(id);
    return row ? scopeGrantFromRow(row) : undefined;
  }

  listScopeGrants(): ScopeGrant[] {
    return this.database.query<ScopeGrantRow, []>(
      `SELECT ${GRANT_COLUMNS} FROM scope_grants ORDER BY last_used_at DESC, id DESC`,
    ).all().map(scopeGrantFromRow);
  }

  touchScopeGrant(id: string): void {
    this.database.query(`
      UPDATE scope_grants SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  revokeScopeGrant(id: string): boolean {
    return this.database.query("DELETE FROM scope_grants WHERE id = ?").run(id).changes === 1;
  }

  /** Sizes every cwd holding memories in one grouped read, values left behind. */
  listMemoryProjects(): MemoryProject[] {
    return this.database.query<{
      cwd: string; count: number; chars: number; updated_at: string;
    }, []>(`
      SELECT cwd, COUNT(*) AS count, SUM(LENGTH(value)) AS chars, MAX(updated_at) AS updated_at
      FROM memories GROUP BY cwd ORDER BY cwd
    `).all().map((row) => ({
      cwd: row.cwd,
      count: row.count,
      chars: row.chars,
      updatedAt: row.updated_at,
    }));
  }

  listMemories(cwd: string): MemoryEntry[] {
    return this.database.query<{
      cwd: string; key: string; value: string; version: number; created_at: string; updated_at: string;
    }, [string]>(`
      SELECT cwd, key, value, version, created_at, updated_at
      FROM memories WHERE cwd = ? ORDER BY key
    `).all(resolve(cwd)).map(memoryFromRow);
  }

  getMemory(cwd: string, key: string): MemoryEntry | undefined {
    const row = this.database.query<{
      cwd: string; key: string; value: string; version: number; created_at: string; updated_at: string;
    }, [string, string]>(`
      SELECT cwd, key, value, version, created_at, updated_at
      FROM memories WHERE cwd = ? AND key = ?
    `).get(resolve(cwd), key);
    return row ? memoryFromRow(row) : undefined;
  }

  setMemory(cwd: string, key: string, value: string, expectedVersion?: number): MemoryEntry {
    const project = resolve(cwd);
    const current = this.getMemory(project, key);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new Error(`memory version conflict: expected ${expectedVersion}, found ${current?.version ?? 0}`);
    }
    const now = new Date().toISOString();
    this.database.query(`
      INSERT INTO memories(cwd, key, value, version, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(cwd, key) DO UPDATE SET
        value = excluded.value,
        version = memories.version + 1,
        updated_at = excluded.updated_at
    `).run(project, key, value, now, now);
    return this.getMemory(project, key)!;
  }

  deleteMemory(cwd: string, key: string, expectedVersion?: number): boolean {
    const project = resolve(cwd);
    const current = this.getMemory(project, key);
    if (!current) return false;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error(`memory version conflict: expected ${expectedVersion}, found ${current.version}`);
    }
    return this.database.query("DELETE FROM memories WHERE cwd = ? AND key = ?")
      .run(project, key).changes === 1;
  }

  createTask(task: Task): void {
    this.database.query(`
      INSERT INTO tasks(
        id, profile_id, model, prompt, cwd, state, output, error, question,
        parent_task_id, scope_json, grant_id, allow_questions, timeout_ms,
        effort, tldr, title, session_id, completion_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.profileId, task.model, task.prompt, task.cwd, task.state,
      task.output, task.error ?? null, task.question ?? null, task.parentTaskId ?? null,
      JSON.stringify(task.scope), task.grantId ?? null, task.allowQuestions ? 1 : 0,
      task.timeoutMs ?? null, task.effort ?? null, task.tldr ?? null, task.title ?? null, task.sessionId ?? null,
      task.completion ? JSON.stringify(task.completion) : null,
      task.createdAt, task.updatedAt,
    );
    this.addTaskEvent(task.id, "created", task.state, {});
  }

  /**
   * Stores the text the worker actually received. The caller's prompt is only
   * part of it: memories and the protocol wrapper are appended at launch, and
   * without this the product cannot answer what was sent to the provider.
   */
  recordShippedPrompt(id: string, shippedPrompt: string): void {
    this.database.query("UPDATE tasks SET shipped_prompt = ? WHERE id = ?").run(shippedPrompt, id);
  }

  /** Rolls a run's reported cost onto the task so spend survives the event stream. */
  recordTaskCost(id: string, costUsd?: number, turns?: number): void {
    if (costUsd === undefined && turns === undefined) return;
    this.database.query(`
      UPDATE tasks
      SET cost_usd = COALESCE(cost_usd, 0) + COALESCE(?, 0),
          turns = COALESCE(turns, 0) + COALESCE(?, 0)
      WHERE id = ?
    `).run(costUsd ?? null, turns ?? null, id);
  }

  captureTaskSessionId(id: string, provider: Profile["provider"], sessionId: string): boolean {
    const value = sessionId.trim();
    if (!value) return false;
    let captured = false;
    this.transaction(() => {
      const row = this.database.query<{ state: TaskState }, [string]>(`
        SELECT state FROM tasks
        WHERE id = ? AND COALESCE(TRIM(session_id), '') = ''
      `).get(id);
      if (!row) return;
      const changed = this.database.query(`
        UPDATE tasks SET session_id = ?
        WHERE id = ? AND COALESCE(TRIM(session_id), '') = ''
      `).run(value, id);
      if (changed.changes !== 1) return;
      this.addTaskEvent(id, "session_captured", row.state, { provider, sessionId: value });
      captured = true;
    });
    return captured;
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
          state = ?, output = ?, error = ?, question = ?,
          completion_json = ?, updated_at = ?
        WHERE id = ? ${expected}
      `).run(
        task.state, task.output, task.error ?? null, task.question ?? null,
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
    // A timeout is the broker stopping work the caller still wanted, so it
    // lands in `failed`; `cancelled` stays reserved for explicit caller stops.
    const state = completion.code === "timeout" ? "failed" : "cancelled";
    let cancelled = false;
    this.transaction(() => {
      // A task parked on a question or blocked mid-run is exactly the one a
      // caller most often wants to abandon, so those states cancel too.
      const changed = this.database.query(`
        UPDATE tasks
        SET state = ?, error = ?, completion_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'running', 'needs_input', 'blocked')
      `).run(state, reason, JSON.stringify(completion), now, id);
      if (changed.changes !== 1) return;
      this.addTaskEvent(id, state, state, { error: reason, completion });
      cancelled = true;
    });
    return cancelled ? this.getTask(id) : undefined;
  }

  answerTask(
    id: string,
    updates: { answer?: string; scope?: TaskScope; grantId?: string } = {},
  ): Task {
    const now = new Date().toISOString();
    let answered = false;
    this.transaction(() => {
      const attempts = this.closeAttempt(id, now);
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'queued', output = '', error = NULL, question = NULL,
            completion_json = NULL, attempts_json = ?,
            scope_json = COALESCE(?, scope_json),
            grant_id = COALESCE(?, grant_id),
            updated_at = ?
        WHERE id = ? AND state = 'needs_input'
      `).run(
        JSON.stringify(attempts),
        updates.scope ? JSON.stringify(updates.scope) : null,
        updates.grantId ?? null,
        now,
        id,
      );
      if (changed.changes !== 1) throw new Error(`task does not need input: ${id}`);
      // The answer lives on the event, not the row: a task answered repeatedly
      // carries one `answered` event per attempt, each with its own answer.
      this.addTaskEvent(id, "answered", "queued", {
        attempt: attempts.length,
        ...(updates.answer ? { answer: updates.answer } : {}),
        ...(updates.scope ? { scopeUpdated: true } : {}),
      });
      answered = true;
    });
    const task = answered ? this.getTask(id) : undefined;
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }

  /**
   * Moves the finished run's result into `attempts` and returns the new list.
   * Reply and resume reuse the same row, so without this the output that
   * prompted the question is overwritten by the run that answers it.
   */
  private closeAttempt(id: string, endedAt: string): TaskAttempt[] {
    const row = this.database.query<{
      output: string;
      error: string | null;
      question: string | null;
      completion_json: string | null;
      attempts_json: string | null;
      profile_id: string;
      session_id: string | null;
    }, [string]>(`
      SELECT output, error, question, completion_json, attempts_json, profile_id, session_id
      FROM tasks WHERE id = ?
    `).get(id);
    if (!row) return [];
    const attempts = row.attempts_json ? JSON.parse(row.attempts_json) as TaskAttempt[] : [];
    if (!row.output && !row.error && !row.question) return attempts;
    // A task can be answered or resumed indefinitely, and each attempt carries a
    // full worker output. Keeping only the most recent bounds both the row and
    // the JSON parse every read of that row pays for.
    while (attempts.length >= MAX_ATTEMPTS) attempts.shift();
    attempts.push({
      output: row.output,
      ...(row.error ? { error: row.error } : {}),
      ...(row.question ? { question: row.question } : {}),
      ...(row.completion_json
        ? { completion: JSON.parse(row.completion_json) as TaskCompletion }
        : {}),
      endedAt,
      // Where this run ran. Handoff moves both off the row, and then the
      // attempt is the only record of which account holds the earlier session.
      profileId: row.profile_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    });
    return attempts;
  }

  resumeTask(
    id: string,
    updates: {
      timeoutMs?: number;
      scope?: TaskScope;
      grantId?: string;
      allowQuestions?: boolean;
    } = {},
  ): Task {
    const now = new Date().toISOString();
    let resumed = false;
    this.transaction(() => {
      const current = this.database.query<{ state: TaskState }, [string]>(`
        SELECT state FROM tasks WHERE id = ?
      `).get(id);
      if (!current || !["failed", "cancelled", "blocked"].includes(current.state)) {
        throw new Error(`task cannot be resumed: ${id}`);
      }
      const attempts = this.closeAttempt(id, now);
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'queued', output = '', error = NULL, question = NULL,
            completion_json = NULL, attempts_json = ?, timeout_ms = COALESCE(?, timeout_ms),
            scope_json = COALESCE(?, scope_json),
            grant_id = COALESCE(?, grant_id),
            allow_questions = COALESCE(?, allow_questions), updated_at = ?
        WHERE id = ?
          AND state IN ('failed', 'cancelled', 'blocked')
      `).run(
        JSON.stringify(attempts),
        updates.timeoutMs ?? null,
        updates.scope ? JSON.stringify(updates.scope) : null,
        updates.grantId ?? null,
        updates.allowQuestions === undefined ? null : updates.allowQuestions ? 1 : 0,
        now,
        id,
      );
      if (changed.changes !== 1) throw new Error(`task cannot be resumed: ${id}`);
      this.addTaskEvent(id, "resumed", "queued", {
        previousState: current.state,
        attempt: attempts.length,
        ...(updates.timeoutMs !== undefined ? { timeoutMs: updates.timeoutMs } : {}),
        ...(updates.scope ? { scopeUpdated: true } : {}),
        ...(updates.allowQuestions !== undefined ? { allowQuestions: updates.allowQuestions } : {}),
      });
      resumed = true;
    });
    const task = resumed ? this.getTask(id) : undefined;
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }

  /**
   * Moves a dead task to another provider account: same row, same id, same
   * lineage, fresh session. Resume's SQL cannot do this — it holds the profile
   * and the session steady on purpose — so the two stay separate statements.
   */
  handoffTask(
    id: string,
    updates: {
      profileId: string;
      model: string;
      effort?: string;
      scope?: TaskScope;
      grantId?: string;
    },
  ): Task {
    const now = new Date().toISOString();
    let handed = false;
    this.transaction(() => {
      const current = this.database.query<{
        state: TaskState;
        profile_id: string;
        session_id: string | null;
      }, [string]>(`
        SELECT state, profile_id, session_id FROM tasks WHERE id = ?
      `).get(id);
      if (!current || !["failed", "cancelled", "blocked"].includes(current.state)) {
        throw new Error(`task cannot be handed off: ${id}`);
      }
      const attempts = this.closeAttempt(id, now);
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'queued', output = '', error = NULL, question = NULL,
            completion_json = NULL, attempts_json = ?,
            profile_id = ?, model = ?, effort = ?, session_id = NULL,
            scope_json = COALESCE(?, scope_json),
            grant_id = COALESCE(?, grant_id),
            updated_at = ?
        WHERE id = ?
          AND state IN ('failed', 'cancelled', 'blocked')
      `).run(
        JSON.stringify(attempts),
        updates.profileId,
        updates.model,
        updates.effort ?? null,
        updates.scope ? JSON.stringify(updates.scope) : null,
        updates.grantId ?? null,
        now,
        id,
      );
      if (changed.changes !== 1) throw new Error(`task cannot be handed off: ${id}`);
      this.addTaskEvent(id, "handed_off", "queued", {
        previousState: current.state,
        fromProfile: current.profile_id,
        toProfile: updates.profileId,
        model: updates.model,
        attempt: attempts.length,
        ...(current.session_id ? { previousSessionId: current.session_id } : {}),
      });
      handed = true;
    });
    const task = handed ? this.getTask(id) : undefined;
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.database.query<TaskRow, [string]>(`
      SELECT ${TASK_COLUMNS}
      FROM tasks WHERE id = ?
    `).get(id);
    return row ? taskFromRow(row) : undefined;
  }

  listTasks(limit = 200, archived: TaskListQuery["archived"] = "active"): Task[] {
    const where = archiveClause(archived);
    return this.database.query<TaskRow, [number]>(`
      SELECT ${TASK_COLUMNS}
      FROM tasks
      WHERE ${where}
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
    if (query.parent) {
      // The batch is the parent plus everything fanned out under it.
      clauses.push("(parent_task_id = ? OR id = ?)");
      values.push(query.parent, query.parent);
    }
    clauses.push(archiveClause(query.archived));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.query<TaskRow, Array<string | number>>(`
      SELECT ${TASK_COLUMNS}
      FROM tasks
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...values, limit);
    return rows.map(taskSummaryFromRow);
  }

  setTaskArchived(id: string, archived: boolean): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (Boolean(task.archivedAt) === archived) return task;
    const now = new Date().toISOString();
    this.transaction(() => {
      const changed = this.database.query(`
        UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?
      `).run(archived ? now : null, now, id);
      if (changed.changes !== 1) throw new Error(`unknown task: ${id}`);
      this.addTaskEvent(id, archived ? "archived" : "unarchived", task.state, {});
    });
    return this.getTask(id)!;
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
    const meaningful = meaningfulOnly ? `AND event_type NOT IN ${NOISE_EVENTS}` : "";
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
        meaningfulOnly ? `AND event_type NOT IN ${NOISE_EVENTS}` : ""
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
    retryAt?: string,
  ): void {
    const failedAt = new Date().toISOString();
    const resolvedRetryAt = code === "rate_limit"
      ? retryAt ?? new Date(Date.parse(failedAt) + 10 * 60_000).toISOString()
      : null;
    this.database.query(`
      INSERT INTO profile_failures(
        profile_id, code, message, failed_at, consecutive_failures, retry_at
      )
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        code = excluded.code,
        message = excluded.message,
        failed_at = excluded.failed_at,
        consecutive_failures = profile_failures.consecutive_failures + 1,
        retry_at = excluded.retry_at
    `).run(profileId, code, message.slice(0, 1_000), failedAt, resolvedRetryAt);
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
      retry_at: string | null;
    }, []>(`
      SELECT profile_id, code, message, failed_at, consecutive_failures, retry_at
      FROM profile_failures
    `).all().map((row) => ({
      profileId: row.profile_id,
      code: row.code,
      message: row.message,
      failedAt: row.failed_at,
      consecutiveFailures: row.consecutive_failures,
      ...(row.retry_at ? { retryAt: row.retry_at } : {}),
    }));
  }

  listProfileSuccesses(): ProfileSuccess[] {
    return this.database.query<{
      profile_id: string;
      succeeded_at: string;
    }, []>(`
      SELECT profile_id, MAX(updated_at) AS succeeded_at
      FROM tasks
      WHERE state = 'completed'
      GROUP BY profile_id
    `).all().map((row) => ({
      profileId: row.profile_id,
      succeededAt: row.succeeded_at,
    }));
  }

  private configure(): void {
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
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
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex','opencode','antigravity','pi')),
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
        scope_json TEXT NOT NULL DEFAULT '{"read":["**"],"write":["**"]}' CHECK(json_valid(scope_json)),
        grant_id TEXT,
        allow_questions INTEGER NOT NULL DEFAULT 1 CHECK(allow_questions IN (0,1)),
        timeout_ms INTEGER,
        session_id TEXT,
        shipped_prompt TEXT,
        completion_json TEXT CHECK(completion_json IS NULL OR json_valid(completion_json)),
        attempts_json TEXT CHECK(attempts_json IS NULL OR json_valid(attempts_json)),
        cost_usd REAL,
        turns INTEGER,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);
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
        consecutive_failures INTEGER NOT NULL,
        retry_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        cwd TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(cwd, key)
      );
      CREATE TABLE IF NOT EXISTS scope_grants (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        profile_id TEXT,
        scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS scope_grants_cwd ON scope_grants(cwd, last_used_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (1, 'profiles tasks and events');
    `);
    const columns = new Set(this.database.query<{ name: string }, []>(
      "PRAGMA table_info(tasks)",
    ).all().map(({ name }) => name));
    if (!columns.has("scope_json")) this.migrateTaskContract();
    // Re-read: migrateTaskContract rebuilds the table without newer columns.
    const taskColumns = new Set(this.database.query<{ name: string }, []>(
      "PRAGMA table_info(tasks)",
    ).all().map(({ name }) => name));
    if (!taskColumns.has("session_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
    }
    if (!taskColumns.has("archived_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
    }
    for (const [column, type] of [
      ["grant_id", "TEXT"],
      ["shipped_prompt", "TEXT"],
      ["attempts_json", "TEXT"],
      ["cost_usd", "REAL"],
      ["turns", "INTEGER"],
      ["effort", "TEXT"],
      ["tldr", "TEXT"],
      ["title", "TEXT"],
    ] as const) {
      if (!taskColumns.has(column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
      }
    }
    // child_task_id was never written by any code path, so it always read NULL
    // and made the lineage look richer than it was.
    if (taskColumns.has("child_task_id")) {
      this.database.exec("ALTER TABLE tasks DROP COLUMN child_task_id");
    }
    // Grants predating per-destination approval keep a NULL profile_id, which
    // reads as "approved for no particular profile" and so always reports as
    // inherited rather than silently counting as this profile's own.
    const grantColumns = new Set(this.database.query<{ name: string }, []>(
      "PRAGMA table_info(scope_grants)",
    ).all().map(({ name }) => name));
    if (grantColumns.size > 0 && !grantColumns.has("profile_id")) {
      this.database.exec("ALTER TABLE scope_grants ADD COLUMN profile_id TEXT");
    }
    const failureColumns = new Set(this.database.query<{ name: string }, []>(
      "PRAGMA table_info(profile_failures)",
    ).all().map(({ name }) => name));
    if (!failureColumns.has("retry_at")) {
      this.database.exec("ALTER TABLE profile_failures ADD COLUMN retry_at TEXT");
      this.database.exec(`
        UPDATE profile_failures
        SET retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', failed_at, '+10 minutes')
        WHERE code = 'rate_limit'
      `);
    }
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (2, 'task scope lifecycle and completion')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (3, 'profile failure retry timestamps')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (4, 'task worker session ids')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (6, 'project memories')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (7, 'task archives')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (8, 'scope grants, shipped prompts, attempts and cost')
    `).run();
    this.database.query(`
      INSERT OR IGNORE INTO schema_migrations(version, name)
      VALUES (9, 'task titles')
    `).run();
    this.widenProviderCheck();
    const backfilled = this.database.query<{ version: number }, []>(
      "SELECT version FROM schema_migrations WHERE version = 5",
    ).get();
    if (!backfilled) {
      this.backfillTaskSessionIds();
      this.database.query(`
        INSERT INTO schema_migrations(version, name)
        VALUES (5, 'backfill task worker session ids')
      `).run();
    }
  }

  private backfillTaskSessionIds(): void {
    const rows = this.database.query<{
      task_id: string;
      provider: Profile["provider"];
      payload: string;
    }, []>(`
      SELECT tasks.id AS task_id, profiles.provider, task_events.payload
      FROM tasks
      JOIN profiles ON profiles.id = tasks.profile_id
      JOIN task_events ON task_events.task_id = tasks.id
      WHERE COALESCE(TRIM(tasks.session_id), '') = ''
      ORDER BY tasks.id, task_events.id
    `).all();
    const repaired = new Set<string>();
    for (const row of rows) {
      if (repaired.has(row.task_id)) continue;
      try {
        const payload = JSON.parse(row.payload) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const sessionId = sessionIdFrom(row.provider, payload as Record<string, unknown>);
        if (sessionId && this.captureTaskSessionId(row.task_id, row.provider, sessionId)) {
          repaired.add(row.task_id);
        }
      } catch {}
    }
  }

  // A CHECK cannot be altered in place, so a database created before pi rejects
  // a pi profile the moment one is saved and the only fix is a table copy. The
  // schema text is the guard: a database already carrying pi does nothing.
  private widenProviderCheck(): void {
    const existing = this.database.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    ).get();
    if (!existing || existing.sql.includes("'pi'")) return;
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE profiles_v2 (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('claude','codex','opencode','antigravity','pi')),
          default_model TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          env_json TEXT NOT NULL CHECK(json_valid(env_json)),
          capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
          command_json TEXT CHECK(command_json IS NULL OR json_valid(command_json)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          deleted_at TEXT
        );
        INSERT INTO profiles_v2(
          id, label, provider, default_model, enabled, env_json, capabilities_json,
          command_json, created_at, updated_at, deleted_at
        )
        SELECT id, label, provider, default_model, enabled, env_json, capabilities_json,
          command_json, created_at, updated_at, deleted_at
        FROM profiles;
        DROP TABLE profiles;
        ALTER TABLE profiles_v2 RENAME TO profiles;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
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

  private seed(profiles: () => Profile[]): void {
    const seeded = this.database.query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    ).get("profiles_initialized");
    if (seeded) return;

    this.saveProfiles(profiles());
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

function memoryFromRow(row: {
  cwd: string; key: string; value: string; version: number; created_at: string; updated_at: string;
}): MemoryEntry {
  return {
    cwd: row.cwd,
    key: row.key,
    value: row.value,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  if (Bun.env.INTER_DB) return resolve(Bun.env.INTER_DB);
  // Opening the store runs migrations. A test that reaches this path would
  // migrate the developer's live broker database out from under the running
  // app, so tests must always name their own file.
  if (Bun.env.NODE_ENV === "test") {
    throw new Error(
      "refusing to open the default broker database from a test; set INTER_DB to a temporary path first",
    );
  }
  return join(homedir(), ".inter", "inter.db");
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
    ...(row.shipped_prompt ? { shippedPrompt: row.shipped_prompt } : {}),
    cwd: row.cwd,
    state: row.state,
    output: row.output,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
    ...(row.question ? { question: row.question } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    scope: JSON.parse(row.scope_json) as Task["scope"],
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    allowQuestions: row.allow_questions === 1,
    ...(row.timeout_ms ? { timeoutMs: row.timeout_ms } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.tldr ? { tldr: row.tldr } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.completion_json
      ? { completion: JSON.parse(row.completion_json) as TaskCompletion }
      : {}),
    ...(row.attempts_json
      ? { attempts: JSON.parse(row.attempts_json) as TaskAttempt[] }
      : {}),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    ...(row.turns === null ? {} : { turns: row.turns }),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

interface ScopeGrantRow {
  id: string;
  cwd: string;
  profile_id: string | null;
  scope_json: string;
  created_at: string;
  last_used_at: string;
  use_count: number;
}

function scopeGrantFromRow(row: ScopeGrantRow): ScopeGrant {
  return {
    id: row.id,
    cwd: row.cwd,
    profileId: row.profile_id ?? "",
    scope: JSON.parse(row.scope_json) as TaskScope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

// Builds the summary from the row directly. Going through taskFromRow would
// JSON.parse the full attempt history for every listed task only to discard it,
// and the app polls this list continuously.
function taskSummaryFromRow(row: TaskRow): TaskSummary {
  const task = taskFromRow({ ...row, attempts_json: null });
  return {
    id: task.id,
    profileId: task.profileId,
    model: task.model,
    cwd: task.cwd,
    state: task.state,
    promptPreview: task.prompt.replace(/\s+/g, " ").trim().slice(0, 240),
    ...(task.tldr ? { tldr: task.tldr } : {}),
    ...(task.title ? { title: task.title } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error.slice(0, 500) } : {}),
    ...(task.question ? { question: task.question } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.grantId ? { grantId: task.grantId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.completion ? { completion: task.completion } : {}),
    ...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
  };
}

function archiveClause(archived: TaskListQuery["archived"] = "active"): string {
  if (archived === "include") return "1 = 1";
  return archived === "only" ? "archived_at IS NOT NULL" : "archived_at IS NULL";
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
