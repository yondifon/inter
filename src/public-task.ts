import type { Task, TaskState, TaskSummary } from "./types";

export const TASK_FIELD_GROUPS = {
  routing: ["profileId", "model", "effort"],
  context: ["cwd", "createdAt", "updatedAt", "title", "tldr", "parentTaskId"],
  scope: ["scope", "grantId", "allowQuestions", "timeoutMs"],
  prompt: ["prompt"],
  shippedPrompt: ["shippedPrompt"],
  output: ["output"],
  attempts: ["attempts"],
  completion: ["completion", "error", "question"],
  spend: ["costUsd", "turns"],
} as const;

export const TASK_FIELD_KEYS = [...Object.keys(TASK_FIELD_GROUPS), "all"] as const;
export type TaskField = (typeof TASK_FIELD_KEYS)[number];

export function publicTask(task: Task): Omit<Task, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

export function publicTaskSummary(task: TaskSummary): Omit<TaskSummary, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

/**
 * Return what a caller asked for, and nothing else. The floor is id, state,
 * plus attemptCount when there are prior attempts and archivedAt when set.
 * Most callers already have the data they just sent, which is why the floor is
 * so bare. Pass {@link TaskField} groups to pull in the parts the caller
 * genuinely needs. `"all"` expands to every group. Never emits `sessionId`.
 */
export function taskView(task: Task, fields: readonly TaskField[]): Record<string, unknown> {
  const groups = fields.includes("all")
    ? Object.keys(TASK_FIELD_GROUPS)
    : fields;
  const want = new Set(groups.flatMap((g) => (TASK_FIELD_GROUPS as Record<string, readonly string[]>)[g] ?? []));

  return {
    id: task.id,
    state: task.state,
    // attemptCount is always on — it is a number, and it tells the caller there
    // is an attempts group worth asking for.
    ...(task.attempts?.length ? { attemptCount: task.attempts.length } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),

    // routing
    ...(want.has("profileId") ? { profileId: task.profileId } : {}),
    ...(want.has("model") ? { model: task.model } : {}),
    ...(want.has("effort") && task.effort ? { effort: task.effort } : {}),

    // context
    ...(want.has("cwd") ? { cwd: task.cwd } : {}),
    ...(want.has("createdAt") ? { createdAt: task.createdAt } : {}),
    ...(want.has("updatedAt") ? { updatedAt: task.updatedAt } : {}),
    ...(want.has("title") && task.title ? { title: task.title } : {}),
    ...(want.has("tldr") && task.tldr ? { tldr: task.tldr } : {}),
    ...(want.has("parentTaskId") && task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),

    // scope
    ...(want.has("scope") ? { scope: task.scope } : {}),
    ...(want.has("grantId") && task.grantId ? { grantId: task.grantId } : {}),
    ...(want.has("allowQuestions") ? { allowQuestions: task.allowQuestions } : {}),
    ...(want.has("timeoutMs") && task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),

    // prompt
    ...(want.has("prompt") ? { prompt: task.prompt } : {}),

    // shippedPrompt
    ...(want.has("shippedPrompt") && task.shippedPrompt ? { shippedPrompt: task.shippedPrompt } : {}),

    // output
    ...(want.has("output") ? { output: task.output } : {}),

    // attempts (the full array, not just the count)
    ...(want.has("attempts") && task.attempts?.length ? { attempts: task.attempts } : {}),

    // completion
    ...(want.has("completion") && task.completion ? { completion: task.completion } : {}),
    ...(want.has("error") && task.error ? { error: task.error } : {}),
    ...(want.has("question") && task.question ? { question: task.question } : {}),

    // spend
    ...(want.has("costUsd") && task.costUsd !== undefined ? { costUsd: task.costUsd } : {}),
    ...(want.has("turns") && task.turns !== undefined ? { turns: task.turns } : {}),
  };
}

export interface WaitTaskView {
  id: string;
  profileId: string;
  model: string;
  cwd: string;
  state: TaskState;
  promptPreview: string;
  /** Caller's own one-line handle; a human scans the list by it, unlike the prompt text. */
  tldr?: string;
  /** Short label for the task, what a sidebar reads at a glance. */
  title?: string;
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
    // The caller's own tldr rides every poll: it is short, and it is the label
    // the human scans for — unlike the prompt, which stays on inspect.
    ...(task.tldr ? { tldr: task.tldr } : {}),
    ...(task.title ? { title: task.title } : {}),
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
