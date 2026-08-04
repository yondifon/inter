export type Provider = "claude" | "codex" | "opencode" | "antigravity" | "pi";
export type TaskState =
  | "queued"
  | "running"
  | "needs_input"
  /**
   * Unreachable: no writer produces it. `answerTask` sets the row back to
   * `queued` and records `answered` as the *event* type, so the state only ever
   * appears in an event log. Kept rather than removed because the string is
   * pinned outside this file — both `CHECK(state IN (…))` constraints in the
   * live schema and the Swift `TaskState` enum decode it — and those have to
   * land together with a migration.
   */
  | "answered"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskScope {
  read: string[];
  write: string[];
}

export type CompletionCode =
  | "completed"
  | "permission_denied"
  | "needs_authority"
  | "unverified"
  | "cancelled"
  | "timeout"
  | "auth"
  | "billing"
  | "rate_limit"
  | "worker_error";

export interface TaskCompletion {
  exitCode?: number;
  blocked: boolean;
  code: CompletionCode;
  reason?: string;
  /** Scope that would have survived the run's sandbox denials; approve on resume. */
  suggestedScope?: TaskScope;
  /**
   * When the provider's rate-limit window clears, ISO. Only set on `rate_limit`.
   * The session on that account stays valid, so this is the caller's choice:
   * wait until then and `resume` for free, or `handoff` now to another profile.
   */
  resetsAt?: string;
}

export interface Profile {
  id: string;
  label: string;
  provider: Provider;
  model: string;
  enabled: boolean;
  env: Record<string, string>;
  capabilities: string[];
  command?: string[];
}

export interface Config {
  profiles: Profile[];
}

/** A scope the caller stated for a cwd, kept so later delegations can reuse it. */
export interface ScopeGrant {
  id: string;
  cwd: string;
  /** Profile the scope was stated for. Approval is per destination, not just per folder. */
  profileId: string;
  scope: TaskScope;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
}

/** What one worker run produced, kept when reply or resume starts the next run. */
export interface TaskAttempt {
  output: string;
  error?: string;
  question?: string;
  completion?: TaskCompletion;
  endedAt: string;
  /**
   * Where this run actually ran. The task row carries the current profile and
   * session, so after a handoff moves both, the attempt is the only record of
   * which account did the earlier work and which session holds it.
   */
  profileId?: string;
  sessionId?: string;
}

export interface MemoryEntry {
  cwd: string;
  key: string;
  value: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One cwd's memory footprint, sized without loading the values themselves. */
export interface MemoryProject {
  cwd: string;
  count: number;
  chars: number;
  updatedAt: string;
}

export interface Task {
  id: string;
  profileId: string;
  model: string;
  prompt: string;
  /** The prompt actually sent to the worker: caller text plus memories and protocol wrapper. */
  shippedPrompt?: string;
  cwd: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  question?: string;
  parentTaskId?: string;
  scope: TaskScope;
  /** Grant the scope came from; absent means the caller stated no scope and none was on file. */
  grantId?: string;
  allowQuestions: boolean;
  timeoutMs?: number;
  /** Reasoning effort requested for this run; persisted so resume reuses it. */
  effort?: string;
  /** Caller's one-line handle for this task, what a human reads instead of the prompt. */
  tldr?: string;
  /** Short label for this task, what a sidebar reads at a glance. */
  title?: string;
  sessionId?: string;
  completion?: TaskCompletion;
  attempts?: TaskAttempt[];
  costUsd?: number;
  turns?: number;
  archivedAt?: string;
}

export interface TaskSummary {
  id: string;
  profileId: string;
  model: string;
  cwd: string;
  state: TaskState;
  promptPreview: string;
  /** Caller's one-line handle for this task, shown in the app's task list. */
  tldr?: string;
  /** Short label for this task, shown in the app's sidebar. */
  title?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  question?: string;
  parentTaskId?: string;
  grantId?: string;
  sessionId?: string;
  completion?: TaskCompletion;
  costUsd?: number;
  archivedAt?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: Provider;
  profileId: string;
  source: "discovered" | "alias" | "configured";
  cost?: {
    input: number;
    output: number;
  };
  contextWindow?: number;
  reasoning?: boolean;
  /// Reasoning effort levels this model accepts, weakest first, as published by
  /// the provider. Undefined means the provider does not publish a ladder, not
  /// that the model has none.
  efforts?: string[];
  defaultEffort?: string;
  toolCall?: boolean;
}
