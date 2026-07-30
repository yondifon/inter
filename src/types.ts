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

export interface BrokerSettings {
  dynamicProfileTools: boolean;
}

export interface Task {
  id: string;
  profileId: string;
  model: string;
  prompt: string;
  cwd: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  question?: string;
  parentTaskId?: string;
  childTaskId?: string;
  scope: TaskScope;
  allowQuestions: boolean;
  timeoutMs?: number;
  sessionId?: string;
  completion?: TaskCompletion;
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
  childTaskId?: string;
  sessionId?: string;
  completion?: TaskCompletion;
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
  toolCall?: boolean;
}
