import type { Task, TaskAttempt, TaskState, TaskSummary } from "./types";

export const TASK_FIELD_GROUPS = {
  routing: ["profileId", "model", "effort", "effortActual"],
  context: ["cwd", "createdAt", "updatedAt", "title", "tldr", "parentTaskId"],
  scope: ["scope", "grantId", "allowQuestions", "timeoutMs"],
  prompt: ["prompt"],
  shippedPrompt: ["shippedPrompt"],
  output: ["output"],
  attempts: ["attempts"],
  completion: ["completion", "error", "question"],
  spend: ["costUsd", "turns"],
} as const satisfies Record<string, readonly (keyof Task)[]>;

export type TaskFieldGroup = keyof typeof TASK_FIELD_GROUPS;
export type TaskField = TaskFieldGroup | "all";

/**
 * Spelled out rather than derived: `Object.keys` returns `string[]`, so building
 * this list from it collapsed {@link TaskField} to `string` and left every
 * `fields` default unchecked. The `satisfies` clause keeps the list honest — a
 * group renamed or dropped from {@link TASK_FIELD_GROUPS} fails to compile here.
 */
export const TASK_FIELD_KEYS = [
  "routing", "context", "scope", "prompt", "shippedPrompt",
  "output", "attempts", "completion", "spend", "all",
] as const satisfies readonly TaskField[];

export function publicTaskSummary(task: TaskSummary): Omit<TaskSummary, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

/**
 * A prior run's provider session is still a provider session. Handoff keeps it
 * on the attempt so the row remembers which account holds that work, but the
 * rule the whole surface runs on does not bend for a nested one.
 */
function publicAttempt(attempt: TaskAttempt): Omit<TaskAttempt, "sessionId"> {
  const { sessionId: _sessionId, ...value } = attempt;
  return value;
}

/**
 * What {@link taskView} emits: the always-present floor, plus whatever groups
 * the caller selected. Never `sessionId` — it is not in `Task`'s public half.
 */
export type TaskFieldView =
  & Partial<Omit<Task, "sessionId" | "id" | "state">>
  & { id: string; state: TaskState; attemptCount?: number; queuedFollowUps?: number };

/**
 * Return what a caller asked for, and nothing else. The floor is id, state,
 * plus attemptCount when there are prior attempts and archivedAt when set.
 * Most callers already have the data they just sent, which is why the floor is
 * so bare. Pass {@link TaskField} groups to pull in the parts the caller
 * genuinely needs. `"all"` expands to every group. Never emits `sessionId`.
 */
export function taskView(task: Task, fields: readonly TaskField[]): TaskFieldView {
  const groups = fields.includes("all") ? TASK_FIELD_KEYS : fields;
  const want = new Set(groups.flatMap((g) => (g === "all" ? [] : TASK_FIELD_GROUPS[g])));

  return {
    id: task.id,
    state: task.state,
    // attemptCount is always on — it is a number, and it tells the caller there
    // is an attempts group worth asking for.
    ...(task.attempts?.length ? { attemptCount: task.attempts.length } : {}),
    // Also always on: one number, and the caller that just queued a follow-up
    // has no other way to learn how many are ahead of it.
    ...(task.queuedFollowUps ? { queuedFollowUps: task.queuedFollowUps } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),

    // routing
    ...(want.has("profileId") ? { profileId: task.profileId } : {}),
    ...(want.has("model") ? { model: task.model } : {}),
    ...(want.has("effort") && task.effort ? { effort: task.effort } : {}),
    ...(want.has("effortActual") && task.effortActual ? { effortActual: task.effortActual } : {}),

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
    ...(want.has("attempts") && task.attempts?.length
      ? { attempts: task.attempts.map(publicAttempt) }
      : {}),

    // completion
    ...(want.has("completion") && task.completion ? { completion: task.completion } : {}),
    ...(want.has("error") && task.error ? { error: task.error } : {}),
    ...(want.has("question") && task.question ? { question: task.question } : {}),

    // spend
    ...(want.has("costUsd") && task.costUsd !== undefined ? { costUsd: task.costUsd } : {}),
    ...(want.has("turns") && task.turns !== undefined ? { turns: task.turns } : {}),
  };
}

/**
 * A listed row, selected by fields the same way {@link taskView} is. The
 * summary carries no session id, so none can leak here either.
 */
export type TaskSummaryView =
  & Partial<Omit<TaskSummary, "sessionId" | "id" | "state">>
  & { id: string; state: TaskState };

/**
 * `tasks` is a listing tool, so its default is what tells one row from the
 * next at a glance and nothing else: who it ran on, when it last moved, and
 * what it cost. The prompt preview, the completion, and the grant each run to
 * hundreds of characters and belong to `inspect`, not to every row of a list —
 * so they come only when `fields` asks. `"all"` is the full summary minus the
 * session id, exactly what the tool returned before this lean default.
 */
export function taskSummaryView(summary: TaskSummary, fields?: readonly TaskField[]): TaskSummaryView {
  const groups = fields?.includes("all") ? TASK_FIELD_KEYS : fields;
  if (!groups) {
    return {
      id: summary.id,
      state: summary.state,
      ...(summary.title ? { title: summary.title } : {}),
      profileId: summary.profileId,
      model: summary.model,
      updatedAt: summary.updatedAt,
      ...(summary.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
      ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : {}),
    };
  }
  const want = new Set(groups.flatMap((g) => (g === "all" ? [] : TASK_FIELD_GROUPS[g])));
  return {
    id: summary.id,
    state: summary.state,
    ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : {}),
    ...(want.has("profileId") ? { profileId: summary.profileId } : {}),
    ...(want.has("model") ? { model: summary.model } : {}),
    ...(want.has("cwd") ? { cwd: summary.cwd } : {}),
    ...(want.has("createdAt") ? { createdAt: summary.createdAt } : {}),
    ...(want.has("updatedAt") ? { updatedAt: summary.updatedAt } : {}),
    ...(want.has("title") && summary.title ? { title: summary.title } : {}),
    ...(want.has("tldr") && summary.tldr ? { tldr: summary.tldr } : {}),
    ...(want.has("parentTaskId") && summary.parentTaskId ? { parentTaskId: summary.parentTaskId } : {}),
    ...(want.has("grantId") && summary.grantId ? { grantId: summary.grantId } : {}),
    // The summary's only trace of the prompt; the full text lives in `inspect`.
    ...(want.has("prompt") ? { promptPreview: summary.promptPreview } : {}),
    ...(want.has("completion") && summary.completion ? { completion: summary.completion } : {}),
    ...(want.has("error") && summary.error ? { error: summary.error } : {}),
    ...(want.has("question") && summary.question ? { question: summary.question } : {}),
    ...(want.has("costUsd") && summary.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
  };
}

/**
 * `wait` is the one tool a caller runs in a loop, so its default is the moving
 * half of a task and nothing else: completion tells it how the run ended, spend
 * tells it what that cost, and `updatedAt` is the clock. Everything static —
 * profile, model, cwd, prompt, title — is the same on the tenth poll as on the
 * first, so it comes only when `fields` asks for it.
 */
const WAIT_DEFAULT_FIELDS: readonly TaskField[] = ["completion", "spend"];

/**
 * What a polling caller needs, and nothing it already has. Passing `fields`
 * replaces this default the same way it does on every other tool — including
 * `["output"]`, which is how a caller reads a finished run without a second
 * `inspect` call.
 */
export function waitTaskView(task: Task, fields?: readonly TaskField[]): TaskFieldView {
  if (fields) return taskView(task, fields);
  // `updatedAt` is the only member of `context` that moves, and the group is
  // all-or-nothing, so it is added rather than selected.
  return { ...taskView(task, WAIT_DEFAULT_FIELDS), updatedAt: task.updatedAt };
}

/** One task's slice of the event stream, with the association hoisted out of the rows. */
export interface WaitEventGroup {
  taskId: string;
  events: Array<{ id: number; type: string; at: string; summary: string }>;
}

/** A summary is a line in a trace, not a transcript; a thinking block is neither. */
const MAX_EVENT_SUMMARY = 160;

/**
 * Fold the flat event list onto its tasks. Every row used to restate `taskId`
 * and `state` — up to a hundred times per call, for a set of at most eight
 * tasks — so the association moves to the group and the per-task state stays
 * where it belongs, on the task. Nothing is lost: the group key names the task,
 * and `id` still orders the rows and feeds the cursor.
 */
export function waitEventsView(
  events: ReadonlyArray<{ id: number; taskId: string; type: string; at: string; summary: string }>,
): WaitEventGroup[] {
  const groups = new Map<string, WaitEventGroup>();
  for (const event of events) {
    let group = groups.get(event.taskId);
    if (!group) groups.set(event.taskId, group = { taskId: event.taskId, events: [] });
    group.events.push({
      id: event.id,
      type: event.type,
      at: event.at,
      summary: preview(event.summary, MAX_EVENT_SUMMARY),
    });
  }
  return [...groups.values()];
}

export function settled(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" ||
    state === "blocked" || state === "needs_input";
}

function preview(text: string, max = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
