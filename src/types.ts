export type Provider = "claude" | "codex" | "opencode" | "antigravity";
export type TaskState =
  | "queued"
  | "running"
  | "needs_input"
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
}

export interface MemoryEntry {
  cwd: string;
  key: string;
  value: string;
  version: number;
  createdAt: string;
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
