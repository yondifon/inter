import { Database } from "bun:sqlite";

export function configureDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * The subset of configureDatabase safe on a read-only handle. WAL is
 * deliberately absent: switching journal mode needs a writable connection,
 * and the broker that owns the file has already set it. busy_timeout and
 * foreign_keys are per-connection settings and never write to the file.
 */
export function configureReadOnlyDatabase(db: Database): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}

// Every schema version this binary knows, newest last. Version 1 is the
// founding ledger row; version 5 is the session-id backfill marker, written
// only after the backfill itself runs, so it is not in the list.
const MIGRATIONS = [
  [2, "task scope lifecycle and completion"],
  [3, "profile failure retry timestamps"],
  [4, "task worker session ids"],
  [6, "project memories"],
  [7, "task archives"],
  [8, "scope grants, shipped prompts, attempts and cost"],
  [9, "task titles"],
  [10, "task worker identity"],
  [11, "task selection records"],
  [12, "profile failure network code"],
  [13, "task token usage"],
  [14, "project context maps"],
] as const;

/**
 * The newest schema this binary can read. Observe-mode opens refuse any
 * database past it: a newer broker migrated it, and reading it blind would
 * show a watcher a view of the file that does not match its queries.
 */
export const LATEST_SCHEMA_VERSION = Math.max(1, ...MIGRATIONS.map(([version]) => version));

export function migrateDatabase(db: Database): { needsSessionBackfill: boolean } {
  db.exec(`
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
      tokens_in INTEGER,
      tokens_out INTEGER,
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
      code TEXT NOT NULL CHECK(code IN ('auth','billing','rate_limit','network')),
      message TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL,
      retry_at TEXT,
      model TEXT
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
    CREATE TABLE IF NOT EXISTS context_maps (
      cwd TEXT PRIMARY KEY,
      scheme INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('building','ready','partial')),
      built_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      pending_prose INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_files (
      cwd TEXT NOT NULL,
      path TEXT NOT NULL,
      lang TEXT NOT NULL,
      purpose TEXT,
      lines INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      digest TEXT NOT NULL,
      symbols_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(symbols_json)),
      status TEXT NOT NULL CHECK(status IN ('mapped','unparsed')),
      touch_count INTEGER NOT NULL DEFAULT 0,
      touched_at TEXT,
      mapped_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(cwd, path)
    );
    CREATE INDEX IF NOT EXISTS context_files_touched ON context_files(cwd, touched_at DESC);
    INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (1, 'profiles tasks and events');
  `);
  const columns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(tasks)",
  ).all().map(({ name }) => name));
  if (!columns.has("scope_json")) migrateTaskContract(db);
  // Re-read: migrateTaskContract rebuilds the table without newer columns.
  const taskColumns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(tasks)",
  ).all().map(({ name }) => name));
  if (!taskColumns.has("session_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
  }
  if (!taskColumns.has("archived_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
  }
  for (const [column, type] of [
    ["grant_id", "TEXT"],
    ["shipped_prompt", "TEXT"],
    ["attempts_json", "TEXT"],
    ["cost_usd", "REAL"],
    ["turns", "INTEGER"],
    ["tokens_in", "INTEGER"],
    ["tokens_out", "INTEGER"],
    ["effort", "TEXT"],
    ["tldr", "TEXT"],
    ["title", "TEXT"],
    // Who this task's worker process is, while it has one. Written at spawn and
    // cleared when the child exits, so a row still carrying one after a restart
    // is the only evidence a detached worker may have outlived the broker.
    ["worker_json", "TEXT"],
    // Why this task went to this profile, model, and effort. The outcome history
    // was complete and the decision history absent, so nothing could tell a good
    // routing call from a lucky caller guess after the fact.
    ["selection_json", "TEXT"],
  ] as const) {
    if (!taskColumns.has(column)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
    }
  }
  // child_task_id was never written by any code path, so it always read NULL
  // and made the lineage look richer than it was.
  if (taskColumns.has("child_task_id")) {
    db.exec("ALTER TABLE tasks DROP COLUMN child_task_id");
  }
  // Grants predating per-destination approval keep a NULL profile_id, which
  // reads as "approved for no particular profile" and so always reports as
  // inherited rather than silently counting as this profile's own.
  const grantColumns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(scope_grants)",
  ).all().map(({ name }) => name));
  if (grantColumns.size > 0 && !grantColumns.has("profile_id")) {
    db.exec("ALTER TABLE scope_grants ADD COLUMN profile_id TEXT");
  }
  const failureColumns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(profile_failures)",
  ).all().map(({ name }) => name));
  if (!failureColumns.has("retry_at")) {
    db.exec("ALTER TABLE profile_failures ADD COLUMN retry_at TEXT");
    db.exec(`
      UPDATE profile_failures
      SET retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', failed_at, '+10 minutes')
      WHERE code = 'rate_limit'
    `);
  }
  if (failureColumns.size > 0 && !failureColumns.has("model")) {
    db.exec("ALTER TABLE profile_failures ADD COLUMN model TEXT");
  }
  for (const [version, name] of MIGRATIONS) {
    db.query("INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (?, ?)")
      .run(version, name);
  }
  widenProviderCheck(db);
  widenProfileFailureCodeCheck(db);
  const backfilled = db.query<{ version: number }, []>(
    "SELECT version FROM schema_migrations WHERE version = 5",
  ).get();
  return { needsSessionBackfill: !backfilled };
}

// A CHECK cannot be altered in place, so a database created before pi rejects
// a pi profile the moment one is saved and the only fix is a table copy. The
// schema text is the guard: a database already carrying pi does nothing.
function widenProviderCheck(db: Database): void {
  const existing = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
  ).get();
  if (!existing || existing.sql.includes("'pi'")) return;
  rebuildTable(db, `
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
}

// Same table-rebuild dance as widenProviderCheck: a CHECK cannot be altered in
// place, so a database created before 'network' rejects that code the moment
// one is recorded.
function widenProfileFailureCodeCheck(db: Database): void {
  const existing = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile_failures'",
  ).get();
  if (!existing || existing.sql.includes("'network'")) return;
  rebuildTable(db, `
    CREATE TABLE profile_failures_v2 (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
      code TEXT NOT NULL CHECK(code IN ('auth','billing','rate_limit','network')),
      message TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL,
      retry_at TEXT,
      model TEXT
    );
    INSERT INTO profile_failures_v2(
      profile_id, code, message, failed_at, consecutive_failures, retry_at, model
    )
    SELECT profile_id, code, message, failed_at, consecutive_failures, retry_at, model
    FROM profile_failures;
    DROP TABLE profile_failures;
    ALTER TABLE profile_failures_v2 RENAME TO profile_failures;
  `);
}

function migrateTaskContract(db: Database): void {
  rebuildTable(db, `
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
}

// The one table-rebuild dance: foreign keys off, immediate transaction, the
// rebuild script, commit, and rollback + re-enable on any failure. Rebuilds
// drop and recreate tables, so the guard around the script is load-bearing.
function rebuildTable(db: Database, sql: string): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
