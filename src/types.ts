export type Provider = "claude" | "codex" | "opencode" | "antigravity";
export type TaskState = "queued" | "running" | "needs_input" | "completed" | "failed";

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
