import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { discoverProfiles } from "./profile-discovery";
import { sessionIdFrom } from "./adapters";
import { boundEventPayload } from "./event-bounds";
import {
  configureDatabase,
  configureReadOnlyDatabase,
  LATEST_SCHEMA_VERSION,
  migrateDatabase,
} from "./store/schema";
import { parseWorkerIdentity, probeWorker, signalWorkerGroup, type WorkerIdentity } from "./worker-identity";
import type {
  Profile,
  MemoryEntry,
  MemoryProject,
  ScopeGrant,
  Task,
  TaskAttempt,
  TaskCompletion,
  TaskCompletionOverride,
  TaskSelection,
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

// The window `spendTotals` sums over. A running total that never resets would
// only ever grow and stop meaning anything within a week; a day is long enough
// to read as "what tonight cost" without needing a picker.
const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

const GRANT_COLUMNS = "id, cwd, profile_id, scope_json, created_at, last_used_at, use_count";

/**
 * The only states whose history cleanup may ever delete. `queued`, `running`,
 * `needs_input`, `answered` and `blocked` are absent on purpose: each is work
 * that is still moving or still waiting on a person, and no age makes it stale.
 *
 * Deliberately not `settled` from public-task — that helper counts `blocked` and
 * `needs_input` as settled so a watcher stops following them, which is a
 * different question from whether the work is finished with.
 */
const DELETABLE_STATES = "('completed','failed','cancelled')";

/**
 * The three gates a task passes before its history can go: the run finished, it
 * was archived — a hand action meaning "done with this", because age alone is
 * never consent — and it has not changed since the cutoff. Written once and
 * applied to a parent, its children, and the held-back count, so no caller can
 * be reasoning about a different rule than the delete is.
 *
 * Carries one `?` for the cutoff, per use.
 */
function settledAndArchived(table: string): string {
  return `${table}.state IN ${DELETABLE_STATES}
    AND ${table}.archived_at IS NOT NULL
    AND ${table}.updated_at < ?`;
}

/**
 * Which tasks cleanup may touch, written once so the preview and the delete
 * cannot disagree: the gates above, plus one lineage rule. A task that fanned
 * work out keeps its history for as long as any task delegated under it fails
 * those gates — reading a batch's origin is how its children are understood,
 * and a child still running has no business losing its parent's trace. The
 * check is one level deep, matching the one-level fan-out `delegate` creates,
 * and a deeper tree only ever holds more back than it deletes.
 *
 * Takes the cutoff twice: once for the task, once for its children.
 */
const ELIGIBLE_TASK_IDS = `
  SELECT parent.id FROM tasks parent
  WHERE ${settledAndArchived("parent")}
    AND NOT EXISTS (
      SELECT 1 FROM tasks child
      WHERE child.parent_task_id = parent.id
        AND NOT (${settledAndArchived("child")})
    )
`;

/** What a cleanup would remove, or did. Counts a person can read back. */
export interface CleanupPlan {
  /** A task must have stopped changing before this to qualify. */
  cutoff: string;
  tasks: number;
  /** Eligible task counts per final state, largest group first. */
  byState: Array<{ state: TaskState; tasks: number }>;
  /** Rows of recorded activity — every step of every run that qualifies. */
  events: number;
  /** Roughly what those rows hold, before index and row overhead. */
  bytes: number;
  /** Finished, archived and old enough, kept because a task under them is not. */
  heldBack: number;
}

/** A cleanup that already ran, kept so an unattended pass is still answerable for. */
export interface CleanupRecord extends CleanupPlan {
  finishedAt: string;
}

export interface CleanupResult extends CleanupRecord {
  fileBytesBefore: number;
  fileBytesAfter: number;
}

/** What tasks have cost and used, summed over the trailing window. */
export interface SpendTotals {
  costUsd: number;
  tokens: number;
  /** Start of the window this was summed over. */
  since: string;
}

const LAST_CLEANUP_KEY = "cleanup_last_run";

// What a task reads when its worker provably did not survive the broker. The
// wording predates worker identity and is kept exactly: this is still the only
// honest thing to say about a run whose process is gone.
const BROKER_RESTART_ERROR = "Broker restarted before task completed";

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
  /**
   * Open without claiming the broker's startup duties. Seeding and interrupted-
   * task recovery both assume the opener is the process that owns the running
   * workers; a second process that merely reads — `inter watch` — would
   * otherwise fail every queued and running task the live broker is still
   * driving, which is the opposite of watching them.
   */
  observe?: boolean;
  /**
   * Open able to write, but without claiming those same startup duties. Cleanup
   * deletes, so it cannot use observe mode, and it must not settle interrupted
   * tasks: a live broker owns those workers, and a maintenance command that
   * reaped them would destroy running work in the name of reclaiming disk.
   */
  maintenance?: boolean;
}

/** A task that would lose its worker if the broker were restarted right now. */
export interface InFlightTask {
  id: string;
  state: TaskState;
  title?: string;
  /** Absent when the task is queued and never spawned, so nothing would be killed. */
  pid?: number;
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
  code: "auth" | "billing" | "rate_limit" | "network";
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
  /** True when this handle must never write, migration included. */
  private readonly observe: boolean;

  constructor(options: StateStoreOptions = {}) {
    this.path = resolve(options.path ?? databasePath());
    this.observe = options.observe === true;
    // Observe mode is a reader's open: it must not create the file, its
    // directory, or touch the broker's live schema. It gets its own branch so
    // every write-capable step below is provably broker-only.
    if (this.observe) {
      this.database = this.openObserve();
      return;
    }
    // A mistyped path must not materialise an empty database for a command
    // whose whole job is to operate on an existing one.
    if (options.maintenance && !existsSync(this.path)) {
      throw new Error(`no database at ${this.path}; run the broker once to create it, or fix INTER_DB`);
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new Database(this.path, { create: true, strict: true });
    try { chmodSync(this.path, 0o600); } catch {}
    configureDatabase(this.database);
    if (options.maintenance) {
      migrateDatabase(this.database);
      return;
    }
    if (migrateDatabase(this.database).needsSessionBackfill) {
      this.backfillTaskSessionIds();
      this.database.query(`
        INSERT INTO schema_migrations(version, name)
        VALUES (5, 'backfill task worker session ids')
      `).run();
    }
    // Passed as a thunk: seeding happens once, but the argument would be
    // evaluated on every start, and discovery reads the home directory.
    this.seed(() => options.seedProfiles ?? discoverProfiles());
    this.recoverInterruptedTasks();
  }

  /**
   * Open the database as a pure reader: no mkdir, no create, no chmod, no
   * migration and no backfill — a watcher must be unable to change the file it
   * is watching, even by accident.
   *
   * bun:sqlite's `readonly` open cannot read WAL-mode databases at all
   * (every query fails with SQLITE_CANTOPEN), and the broker's database is
   * always WAL, so the read-only that works is a no-create open with the
   * connection-level `query_only` guard: any write attempt — migration,
   * backfill, or a stray update — fails with SQLITE_READONLY instead of
   * mutating anything. `create: false` is not enough on its own: bun:sqlite
   * still creates a missing file, so the existence check below is what stops
   * a mistyped path from materialising an empty database.
   *
   * The ledger check keeps an old binary honest in both directions: a schema
   * ahead of LATEST_SCHEMA_VERSION was migrated by a newer broker and this
   * binary cannot read it; one behind it lacks columns this binary's queries
   * assume. A behind schema is only readable after a migration, which observe
   * mode must never run, so the only valid observe target is exactly the
   * schema this binary was built for.
   */
  private openObserve(): Database {
    if (!existsSync(this.path)) {
      throw new Error(
        `cannot observe ${this.path}: no database at this path; run the broker once to create it, or fix INTER_DB`,
      );
    }
    const db = new Database(this.path, { create: false, strict: true });
    db.exec("PRAGMA query_only = ON");
    configureReadOnlyDatabase(db);
    const ledger = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (!ledger) {
      throw new Error(
        `cannot observe ${this.path}: not an inter database (no schema_migrations table)`,
      );
    }
    const applied = db.query<{ version: number | null }, []>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get()?.version ?? 0;
    if (applied > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `cannot observe ${this.path}: database schema v${applied} is newer than this binary knows ` +
        `(v${LATEST_SCHEMA_VERSION}); upgrade inter`,
      );
    }
    if (applied < LATEST_SCHEMA_VERSION) {
      throw new Error(
        `cannot observe ${this.path}: database schema v${applied} predates this binary ` +
        `(v${LATEST_SCHEMA_VERSION}); start the broker once so it migrates the database`,
      );
    }
    return db;
  }

  close(): void {
    // PRAGMA optimize can run ANALYZE, which writes; an observe handle must
    // never write, so only the broker's own handle pays for the tidying.
    if (!this.observe) this.database.exec("PRAGMA optimize");
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

  /**
   * Stores how this task's profile, model, and effort were decided. Written next
   * to the outcome the run produces, which is what makes the pair analysable
   * later: `decidedBy` separates a router decision from a caller's own choice.
   */
  recordTaskSelection(id: string, selection: TaskSelection): void {
    this.database.query("UPDATE tasks SET selection_json = ? WHERE id = ?")
      .run(JSON.stringify(selection), id);
  }

  taskSelection(id: string): TaskSelection | undefined {
    const row = this.database.query<{ selection_json: string | null }, [string]>(
      "SELECT selection_json FROM tasks WHERE id = ?",
    ).get(id);
    return row?.selection_json ? JSON.parse(row.selection_json) as TaskSelection : undefined;
  }

  /** Rolls a run's reported cost and token usage onto the task so spend survives the event stream. */
  recordTaskCost(id: string, costUsd?: number, turns?: number, tokensIn?: number, tokensOut?: number): void {
    if (costUsd === undefined && turns === undefined && tokensIn === undefined && tokensOut === undefined) return;
    this.database.query(`
      UPDATE tasks
      SET cost_usd = COALESCE(cost_usd, 0) + COALESCE(?, 0),
          turns = COALESCE(turns, 0) + COALESCE(?, 0),
          tokens_in = COALESCE(tokens_in, 0) + COALESCE(?, 0),
          tokens_out = COALESCE(tokens_out, 0) + COALESCE(?, 0)
      WHERE id = ?
    `).run(costUsd ?? null, turns ?? null, tokensIn ?? null, tokensOut ?? null, id);
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

  /**
   * Stamp which process is running this task, or clear the stamp when the child
   * exits. Clearing is what keeps the next boot honest: a row that still names
   * a worker is taken as evidence one may be alive, so leaving a finished run's
   * stamp behind would invite the recovery path to probe a recycled pid.
   */
  recordTaskWorker(id: string, identity: WorkerIdentity | undefined): void {
    this.database.query("UPDATE tasks SET worker_json = ? WHERE id = ?")
      .run(identity ? JSON.stringify(identity) : null, id);
  }

  taskWorker(id: string): WorkerIdentity | undefined {
    const row = this.database.query<{ worker_json: string | null }, [string]>(
      "SELECT worker_json FROM tasks WHERE id = ?",
    ).get(id);
    return parseWorkerIdentity(row?.worker_json);
  }

  /**
   * Tasks a broker restart would settle. Deliberately the same states
   * `recoverInterruptedTasks` acts on: a warning that counted tasks recovery
   * leaves alone — one paused on `needs_input`, say — would overstate the cost
   * of restarting. Read without claiming the broker's duties, so asking what a
   * restart costs never causes one.
   */
  inFlightTasks(): InFlightTask[] {
    return this.database.query<{
      id: string; state: TaskState; title: string | null; tldr: string | null; worker_json: string | null;
    }, []>(`
      SELECT id, state, title, tldr, worker_json FROM tasks
      WHERE state IN ('queued', 'running')
      ORDER BY updated_at DESC
    `).all().map((row) => {
      const worker = parseWorkerIdentity(row.worker_json);
      const label = row.title ?? row.tldr ?? undefined;
      return {
        id: row.id,
        state: row.state,
        ...(label ? { title: label } : {}),
        ...(worker ? { pid: worker.pid } : {}),
      };
    });
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

  /**
   * Moves a dead task's state to `completed` on the caller's assertion that the
   * work landed, without touching the original completion: `unverified` and its
   * reason survive so the record still says the worker never attested, and the
   * override carries who asserted, why, and the code it replaced. Only valid
   * from `blocked` and `failed` — those are the states where the worker's
   * outcome is unresolved. Everything else throws: work still in flight, an
   * already-verified completion, and a cancellation are worse records to
   * overwrite than an unverified one.
   */
  assertTaskCompletion(
    id: string,
    updates: { assertedBy: string; reason: string },
  ): Task {
    const now = new Date().toISOString();
    let asserted = false;
    this.transaction(() => {
      const current = this.database.query<{
        state: TaskState;
        completion_json: string | null;
      }, [string]>(`
        SELECT state, completion_json FROM tasks WHERE id = ?
      `).get(id);
      if (!current || !["blocked", "failed"].includes(current.state)) {
        throw new Error(`task cannot be asserted completed from state ${current?.state ?? "unknown"}: ${id}`);
      }
      const existing = current.completion_json
        ? JSON.parse(current.completion_json) as TaskCompletion
        : undefined;
      const override: TaskCompletionOverride = {
        assertedBy: updates.assertedBy,
        reason: updates.reason,
        assertedAt: now,
        // The code the override replaces is derived, never caller-supplied: the
        // caller may correct a verdict but not rewrite it. Absent only when the
        // row never carried a completion (the broker-restart path).
        ...(existing?.code ? { replacedCode: existing.code } : {}),
      };
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'completed', completion_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('blocked', 'failed')
      `).run(JSON.stringify({ ...(existing ?? {}), assertedCompletion: override }), now, id);
      if (changed.changes !== 1) {
        throw new Error(`task cannot be asserted completed from state ${current.state}: ${id}`);
      }
      this.addTaskEvent(id, "completion_asserted", "completed", {
        assertedBy: updates.assertedBy,
        reason: updates.reason,
        ...(existing?.code ? { replacedCode: existing.code } : {}),
        previousState: current.state,
      });
      asserted = true;
    });
    const task = asserted ? this.getTask(id) : undefined;
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }

  /**
   * Force-settles a task the caller has given up waiting on: the state moves to
   * `completed` and the record carries who asserted it and why. Valid from any
   * state but `completed` — a live or parked run stops its worker first, and a
   * `failed` or `cancelled` run moves with no worker left to stop. The
   * existing completion (why it failed, say) is kept next to the assertion.
   * The SQL guard doubles as the refusal, so a row that moved under this call
   * is never overwritten.
   */
  forceCompleteTask(
    id: string,
    updates: { assertedBy: string; reason: string },
  ): Task {
    const now = new Date().toISOString();
    let completed = false;
    this.transaction(() => {
      const current = this.database.query<{
        state: TaskState;
        completion_json: string | null;
      }, [string]>(`
        SELECT state, completion_json FROM tasks WHERE id = ?
      `).get(id);
      const existing = current?.completion_json
        ? JSON.parse(current.completion_json) as TaskCompletion
        : undefined;
      const override: TaskCompletionOverride = {
        assertedBy: updates.assertedBy,
        reason: updates.reason,
        assertedAt: now,
      };
      const changed = this.database.query(`
        UPDATE tasks
        SET state = 'completed', completion_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'running', 'needs_input', 'answered', 'blocked', 'failed', 'cancelled')
      `).run(JSON.stringify({ ...(existing ?? {}), assertedCompletion: override }), now, id);
      if (changed.changes !== 1) {
        throw new Error(`task cannot be marked completed from state ${current?.state ?? "unknown"}: ${id}`);
      }
      this.addTaskEvent(id, "completion_asserted", "completed", {
        assertedBy: updates.assertedBy,
        reason: updates.reason,
        previousState: current?.state,
      });
      completed = true;
    });
    const task = completed ? this.getTask(id) : undefined;
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
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
      // `completed` is here and not on handoff: resume reopens the session that
      // holds the finished run's context, which is the whole point of following
      // one up. The finished result is not lost — closeAttempt files it first.
      if (!current || !["failed", "cancelled", "blocked", "completed"].includes(current.state)) {
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
          AND state IN ('failed', 'cancelled', 'blocked', 'completed')
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

  // The waiter's 100 ms poll only reads `state`, so materialising the whole
  // row — prompt, shipped prompt, output, and three JSON parses — per poll
  // priced the hot loop in bytes instead of task count. A probe that touches
  // exactly the two columns the poll reads keeps that cost flat.
  taskStates(ids: string[]): Map<string, TaskState> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    return new Map(this.database.query<{ id: string; state: TaskState }, string[]>(
      `SELECT id, state FROM tasks WHERE id IN (${placeholders})`,
    ).all(...ids).map(({ id, state }) => [id, state]));
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
    // The MCP `tasks` tool bounds its own `limit` input to 100 via zod; this
    // higher ceiling exists for the /state poll route, which pages the
    // sidebar's "Load more" window in past the old fixed 200-row fetch.
    const limit = Math.min(500, Math.max(1, query.limit ?? 20));
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

  /**
   * Cost and tokens summed over the trailing window, one number the app reads
   * instead of summing every task's row itself. `updated_at` is what a task's
   * cost lands on — `recordTaskCost` runs right after the state transition
   * that closes a run — so it doubles as "spent in the window" without a
   * separate timestamp to maintain.
   */
  spendTotals(windowMs = SPEND_WINDOW_MS): SpendTotals {
    const since = new Date(Date.now() - windowMs).toISOString();
    const row = this.database.query<{ cost_usd: number | null; tokens: number | null }, [string]>(`
      SELECT SUM(cost_usd) AS cost_usd, SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
      FROM tasks WHERE updated_at >= ?
    `).get(since)!;
    return { costUsd: row.cost_usd ?? 0, tokens: row.tokens ?? 0, since };
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

  /**
   * What a cleanup at this cutoff would remove, without removing anything. The
   * execution path reads the same plan through the same query, so a preview a
   * caller acts on describes the delete they get.
   */
  cleanupPlan(cutoff: string): CleanupPlan {
    const byState = this.database.query<{ state: TaskState; tasks: number }, [string, string]>(`
      SELECT state, COUNT(*) AS tasks FROM tasks
      WHERE id IN (${ELIGIBLE_TASK_IDS})
      GROUP BY state
      ORDER BY tasks DESC, state
    `).all(cutoff, cutoff);
    const totals = this.database.query<{ events: number; bytes: number }, [string, string]>(`
      SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes
      FROM task_events
      WHERE task_id IN (${ELIGIBLE_TASK_IDS})
    `).get(cutoff, cutoff)!;
    const tasks = byState.reduce((total, row) => total + row.tasks, 0);
    // Everything the gates pass, before lineage holds any back. The difference
    // is what a person is owed an explanation for.
    const candidates = this.database.query<{ tasks: number }, [string]>(`
      SELECT COUNT(*) AS tasks FROM tasks WHERE ${settledAndArchived("tasks")}
    `).get(cutoff)!.tasks;
    return { cutoff, tasks, byState, events: totals.events, bytes: totals.bytes, heldBack: candidates - tasks };
  }

  /**
   * Permanently deletes the recorded activity of every eligible task, and
   * reports exactly what went. Irreversible: there is no archive behind this and
   * nothing to restore from.
   *
   * Task rows survive — cleanup reclaims what a finished run's step-by-step
   * trace occupies, never the record that the run happened. Memories, scope
   * grants and profiles are outside the statement entirely.
   *
   * The plan is read inside the delete's own transaction so the counts a caller
   * is handed are the counts the database lost, and a mismatch aborts rather
   * than reports a number it cannot stand behind.
   */
  deleteSettledTaskActivity(cutoff: string): CleanupResult {
    const fileBytesBefore = this.fileBytes();
    const finishedAt = new Date().toISOString();
    let plan: CleanupPlan | undefined;
    this.transaction(() => {
      const planned = this.cleanupPlan(cutoff);
      const removed = this.database.query(`
        DELETE FROM task_events WHERE task_id IN (${ELIGIBLE_TASK_IDS})
      `).run(cutoff, cutoff).changes;
      if (removed !== planned.events) {
        throw new Error(
          `cleanup aborted: expected to remove ${planned.events} records, the delete touched ${removed}`,
        );
      }
      plan = planned;
      // Only a pass that removed something is worth remembering: a run that
      // found nothing would otherwise overwrite the record of the run that did.
      if (planned.events > 0) {
        this.database.query(`
          INSERT INTO settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(LAST_CLEANUP_KEY, JSON.stringify({ ...planned, finishedAt }));
      }
    });
    // SQLite holds freed pages inside the file, so a delete alone leaves it the
    // size it was. VACUUM rewrites the file and takes an exclusive lock for the
    // rewrite, which is worth paying only when something was actually removed.
    // In WAL mode the rewrite lands in the write-ahead log, so the checkpoint is
    // what actually shrinks the file a person sees on disk.
    if (plan!.events > 0) {
      this.database.exec("VACUUM");
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return { ...plan!, finishedAt, fileBytesBefore, fileBytesAfter: this.fileBytes() };
  }

  /** What the last cleanup removed, so an unattended run is still answerable for. */
  lastCleanup(): CleanupRecord | undefined {
    const row = this.database.query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    ).get(LAST_CLEANUP_KEY);
    return row ? JSON.parse(row.value) as CleanupRecord : undefined;
  }

  /**
   * What this database costs on disk. The write-ahead log counts: freed pages
   * live there until a checkpoint, so measuring the main file alone would
   * report a reclaim that has not happened yet.
   */
  private fileBytes(): number {
    return [this.path, `${this.path}-wal`].reduce((total, file) => {
      try {
        return total + statSync(file).size;
      } catch {
        return total;
      }
    }, 0);
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

  /**
   * The newest `limit` events of a task, oldest-first — the tail-first read an
   * app opens a long trace with, and the backward page for "load earlier"
   * (`before` cuts the window below an id). Fetches limit+1 so the caller
   * learns whether older rows exist past the slice it gets back.
   */
  listTaskEventsTail(taskId: string, before = 0, limit = 5_000): { events: TaskEvent[]; hasEarlier: boolean } {
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
      WHERE task_id = ?${before > 0 ? " AND id < ?" : ""}
      ORDER BY id DESC
      LIMIT ?
    `).all(taskId, ...(before > 0 ? [before] : []), limit + 1);
    const events = rows.map(taskEventFromRow).reverse();
    // DESC reversed is ascending; the newest `limit` sit at the end of it.
    return { events: events.slice(-limit), hasEarlier: rows.length > limit };
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
    // A rejected credential will not fix itself, but an unreachable host often
    // does; network gets a re-check five minutes out, sooner than the ten
    // minutes rate_limit uses and unlike auth/billing, which never expire.
    const resolvedRetryAt = code === "rate_limit"
      ? retryAt ?? new Date(Date.parse(failedAt) + 10 * 60_000).toISOString()
      : code === "network"
      ? retryAt ?? new Date(Date.parse(failedAt) + 5 * 60_000).toISOString()
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

  private seed(profiles: () => Profile[]): void {
    const seeded = this.database.query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    ).get("profiles_initialized");
    if (seeded) return;

    this.saveProfiles(profiles());
    this.database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run("profiles_initialized", "1");
  }

  /**
   * Settle every task the previous broker was driving, against what is actually
   * true of its worker process rather than against the assumption that all of
   * them died with it.
   *
   * Workers are spawned detached, so a broker's death does not end them. Three
   * outcomes, and the record has to distinguish them:
   *
   * - **Gone** — the process is provably not running (or never started). Fail
   *   it, exactly as before.
   * - **Alive** — the worker outlived the broker and is still writing to the
   *   user's tree. Its stdout pipe died with the old broker, so nothing it does
   *   from here can ever be captured, attributed, or costed: it is an
   *   unsupervised writer in a repository, producing work Inter could never
   *   report on. Reap it and record `cancelled`. The trade is deliberate —
   *   in-flight work since the last event is lost, and the reason it is
   *   affordable is that `session_id` is already persisted, so `resume` picks
   *   the same provider session back up with its context intact. An orphaned
   *   writer is the worse failure.
   * - **Unconfirmed** — the pid exists but identity cannot be established. Say
   *   so and touch nothing. Signalling here is the one move that turns this
   *   recovery into a serious bug, so ambiguity always declines to act, and
   *   `blocked` puts it in front of a human instead of guessing.
   */
  private recoverInterruptedTasks(): void {
    const interrupted = this.database.query<{ id: string; worker_json: string | null }, []>(
      "SELECT id, worker_json FROM tasks WHERE state IN ('queued', 'running')",
    ).all();
    if (interrupted.length === 0) return;
    const now = new Date().toISOString();
    const decided = interrupted.map(({ id, worker_json }) => ({
      id,
      // Reaping runs before the write transaction on purpose: a signal cannot be
      // rolled back, so the record must be written to match what already
      // happened rather than the other way round.
      outcome: this.settleInterruptedWorker(parseWorkerIdentity(worker_json)),
    }));
    this.transaction(() => {
      for (const { id, outcome } of decided) {
        this.database.query(`
          UPDATE tasks SET state = ?, error = ?, worker_json = NULL, updated_at = ?
          WHERE id = ?
        `).run(outcome.state, outcome.error, now, id);
        // Only the new outcomes carry a completion. The failed path is left
        // writing exactly what it always wrote.
        if (outcome.completion) {
          this.database.query("UPDATE tasks SET completion_json = ? WHERE id = ?")
            .run(JSON.stringify(outcome.completion), id);
        }
        this.addTaskEvent(id, "broker_restarted", outcome.state, {
          error: outcome.error,
          worker: outcome.worker,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
      }
    });
  }

  private settleInterruptedWorker(identity: WorkerIdentity | undefined): {
    state: TaskState;
    error: string;
    worker: string;
    detail?: string;
    completion?: TaskCompletion;
  } {
    // No stamp at all: a queued task that never spawned, or a run predating
    // worker identity. Nothing to probe and nothing that could be signalled.
    if (!identity) {
      return { state: "failed", error: BROKER_RESTART_ERROR, worker: "none" };
    }
    const liveness = probeWorker(identity);
    if (liveness.status === "gone") {
      return { state: "failed", error: BROKER_RESTART_ERROR, worker: "gone", detail: liveness.reason };
    }
    if (liveness.status === "unknown") {
      const error =
        `Broker restarted; worker pid ${identity.pid} could not be identified, so it was left alone. ` +
        "It may still be running — check before resuming.";
      return {
        state: "blocked", error, worker: "unconfirmed", detail: liveness.reason,
        completion: { blocked: true, code: "worker_error", reason: error },
      };
    }
    const signal = signalWorkerGroup(identity, "SIGTERM");
    if (signal.outcome === "refused") {
      const error =
        `Broker restarted; worker pid ${identity.pid} is running but could not be confirmed as ours, ` +
        `so it was left alone: ${signal.reason}`;
      return {
        state: "blocked", error, worker: "unconfirmed", detail: signal.reason,
        completion: { blocked: true, code: "worker_error", reason: error },
      };
    }
    if (signal.outcome === "gone") {
      return { state: "failed", error: BROKER_RESTART_ERROR, worker: "gone", detail: signal.reason };
    }
    // Terminated rather than abandoned, so `cancelled` is the honest state: the
    // broker ended this run on purpose. SIGKILL follows for anything that
    // ignores SIGTERM, re-verifying identity first; unref'd so a short-lived
    // CLI process is never held open waiting to escalate.
    const escalate = setTimeout(() => { signalWorkerGroup(identity, "SIGKILL"); }, 2_000);
    escalate.unref?.();
    const error =
      `Broker restarted; worker pid ${identity.pid} outlived it and was stopped because its output ` +
      "could no longer be captured. Resume to continue on the same provider session.";
    return {
      state: "cancelled", error, worker: "reaped",
      completion: { blocked: true, code: "cancelled", reason: error },
    };
  }

  private addTaskEvent(taskId: string, type: string, state: TaskState, payload: Record<string, unknown>): void {
    this.database.query(`
      INSERT INTO task_events(task_id, event_type, state, payload)
      VALUES (?, ?, ?, ?)
    `).run(taskId, type, state, JSON.stringify(boundEventPayload(payload)));
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

/**
 * Claim the shared store as a reader before anything opens it as the broker.
 * A no-op once the store is open, so a caller already running inside the broker
 * keeps the broker's store.
 */
export function observeStateStore(): StateStore {
  return sharedStore ??= new StateStore({ observe: true });
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
