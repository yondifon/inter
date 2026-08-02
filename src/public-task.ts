import type { Task, TaskState, TaskSummary } from "./types";

export function publicTask(task: Task): Omit<Task, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

export function publicTaskSummary(task: TaskSummary): Omit<TaskSummary, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

export interface WaitTaskView {
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
  completion?: Task["completion"];
  costUsd?: number;
  turns?: number;
  attemptCount?: number;
  archivedAt?: string;
  output?: string;
}

/**
 * What a polling caller needs, and nothing it already has. `wait` may be called
 * many times against the same task, so echoing the prompt back on every poll
 * burns the caller's context to repeat what it wrote. The full text stays one
 * `inspect` away; output rides along only once the run has something final to
 * say, which is the point at which the caller stops polling anyway.
 */
export function waitTaskView(task: Task): WaitTaskView {
  return {
    id: task.id,
    profileId: task.profileId,
    model: task.model,
    cwd: task.cwd,
    state: task.state,
    promptPreview: preview(task.prompt),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.question ? { question: task.question } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.grantId ? { grantId: task.grantId } : {}),
    ...(task.completion ? { completion: task.completion } : {}),
    ...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
    ...(task.turns === undefined ? {} : { turns: task.turns }),
    ...(task.attempts?.length ? { attemptCount: task.attempts.length } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    ...(settled(task.state) && task.output ? { output: task.output } : {}),
  };
}

function settled(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" ||
    state === "blocked" || state === "needs_input";
}

function preview(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 240);
}
