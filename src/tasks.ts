import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { abortedTurn, canResumeSession, commandFor, finalText, resumeCommandFor, sessionEffortFrom, sessionIdFrom, writeTargetsFrom } from "./adapters";
import { loadConfig, profileEnv } from "./config";
import { taskEventView, type TaskEventView } from "./events";
import {
  classifyFailure,
  continuationPrompt,
  interpretWorkerOutcome,
  needsInputQuestion,
  rateLimitResetAt,
  workerPrompt,
} from "./task-protocol";
import { handoffBrief } from "./handoff-brief";
import { normalizeTaskScope, sandboxedCommand, scopeCoversPath, scopeRefusedWrite } from "./task-scope";
import { loadWorkerRules, loadMapConfig, DEFAULT_MAP_CONFIG } from "./worker-config";
import { workerPath } from "./worker-path";
import { createTaskWorktree, projectCwd, removeTaskBranch, removeTaskWorktree, requireTaskWorktree } from "./worktree";
import { captureWorkerIdentity } from "./worker-identity";
import { deniedScopePaths, promptReadPaths } from "./prompt-paths";
import { stateStore, type StateStore, type TaskEvent, type TaskListQuery } from "./store";
import { promptWithMemories } from "./memories";
import { contextMapSection, ensureContextMap, queueContextFold } from "./context-map";
import { HOLD_EXPIRY_MS, resolveStartAt } from "./holds";
import { settled } from "./public-task";
import { TaskWaiter, type TaskWaitResult, type WaitUntil } from "./task-waiter";
import type { Profile, SelectionDecision, Task, TaskScope, TaskSummary } from "./types";

const MAX_EVENT_LINE = 64 * 1024;
const MAX_EVENTS = 5_000;
const MAX_OUTPUT = 10 * 1024 * 1024;
// A block that never closes still surfaces a row this often, so a long
// thinking stretch shows progress at ~1 row/s instead of pi's ~80 token rows/s.
const PI_DELTA_FLUSH_MS = 1_000;
/// pi's message_update events, by their assistantMessageEvent.type. Everything
/// else on the wire is stored as-is; only these stream fragments are folded.
const PI_DELTA_TYPES = new Set([
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
]);
const MAX_ANTIGRAVITY_BOOTSTRAP_RETRIES = 2;
// A timed-out worker is stopped by stepping down the signal ladder: SIGINT
// lets the provider CLI flush its session file before it dies, SIGTERM
// escalates after the grace, SIGKILL is the last resort. A hard kill mid-write
// corrupts a provider session and strands the next resume. Explicit cancels do
// not wait on this — the caller asked for a stop, so it is immediate.
const SHUTDOWN_INT_GRACE_MS = 1_500;
const SHUTDOWN_TERM_GRACE_MS = 1_500;
const FORCE_KILL_GRACE_MS = 2_000;
const taskWaiter = new TaskWaiter(
  (id) => stateStore().getTask(id),
  (ids) => stateStore().latestTaskEventId(ids, true),
  (ids) => stateStore().taskStates(ids),
);
type WorkerProcess = ReturnType<typeof Bun.spawn>;
interface ActiveWorker {
  task: Task;
  child: WorkerProcess;
  cancelled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  forceKill?: ReturnType<typeof setTimeout>;
}
const activeWorkers = new Map<string, ActiveWorker>();

export interface DelegateOptions {
  scope?: TaskScope;
  allowQuestions?: boolean;
  timeoutMs?: number;
  /** Reasoning effort. Only codex and opencode expose a lever for it. */
  effort?: string;
  /**
   * How this destination was decided. Stored with the task minus the chosen
   * pair, which is filled in from the row itself so the record can never claim a
   * profile or model the task did not actually run on.
   */
  selection?: SelectionDecision;
  /** Caller's one-line handle for the task, what a human reads instead of the prompt. */
  tldr?: string;
  /** Short label for the task, what a sidebar reads at a glance. */
  title?: string;
  /**
   * Run in a checkout of this repository made for the task, on a branch of its
   * own, so the worker can commit without touching the caller's working tree
   * and several tasks can run on one repo at once.
   */
  worktree?: boolean;
}

export interface ResumeOptions {
  scope?: TaskScope;
  allowQuestions?: boolean;
  timeoutMs?: number;
  /**
   * Model for the continued run on the same profile. The provider session is
   * the conversation; the model is per run, so a session survives the change.
   * Omitted, the task's own model runs.
   */
  model?: string;
  /** Reasoning effort for the continued run. Omitted, the task's own holds. */
  effort?: string;
  /**
   * Hold the resume instead of running it now: the literal `"rate_limit"` to
   * wait for this task's own account to be usable again, an ISO instant, or a
   * duration like `"45m"` / `"4h"`. The task parks as `pending` and the hold
   * sweep releases it when the condition is true.
   */
  startAt?: string;
  /**
   * `"add"` stores the instruction on a task that is still working instead of
   * refusing it; the broker feeds it back into the same session once the run
   * lands clean. `"clear"` removes everything still waiting. On a settled task
   * `"add"` is nothing to act on and the resume runs as it always has.
   */
  queue?: "add" | "clear";
}

export interface ReplyOptions {
  scope?: TaskScope;
}

export interface HandoffOptions {
  /** Model on the destination profile. Omit for that profile's default. */
  model?: string;
  effort?: string;
  /** Fresh approval for the destination; omitted, the task keeps its own scope. */
  scope?: TaskScope;
}

/**
 * Reads a run's own report of what it spent. Providers put it either at the top
 * of the result event or one level down under `result`.
 */
export function runCostFrom(payload: Record<string, unknown>): { costUsd?: number; turns?: number } {
  const nested = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : {};
  const costUsd = numberOr(nested.total_cost_usd, payload.total_cost_usd);
  const turns = numberOr(nested.num_turns, payload.num_turns);
  return {
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(turns === undefined ? {} : { turns }),
  };
}

/**
 * Adds one provider event's reported spend to a run's running total. claude et
 * al. state the whole run's spend once on their final receipt, which replaces
 * the total; pi states it per assistant message instead — every `message_end`
 * carries that message's share at `usage.cost.total` and nothing on the wire
 * reports the run total — so the shares accumulate, and no single message's
 * value may stand in for the run's. Turn count works the same way: providers
 * with a receipt state it once in `num_turns`, while pi closes one `turn_end`
 * per turn, so the turns accumulate too.
 */
export function accumulateRunCost(
  current: { costUsd?: number; turns?: number },
  payload: Record<string, unknown>,
): { costUsd?: number; turns?: number } {
  const reported = runCostFrom(payload);
  if (reported.costUsd !== undefined || reported.turns !== undefined) return reported;
  const share = piMessageCostFrom(payload);
  if (share !== undefined) return { ...current, costUsd: (current.costUsd ?? 0) + share };
  const turn = piTurnCountFrom(payload);
  return turn === undefined ? current : { ...current, turns: (current.turns ?? 0) + turn };
}

/// pi's per-message spend: each assistant `message_end` carries that message's
/// usage, and `cost.total` under it is the message's cost. The
/// openai-completions adapter hoists `usage` to the top level; the documented
/// wire contract nests it under `message`, kept as the fallback.
function piMessageCostFrom(payload: Record<string, unknown>): number | undefined {
  if (payload.type !== "message_end") return undefined;
  const usage = piUsageFrom(payload);
  const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
    ? usage.cost as Record<string, unknown>
    : {};
  return numberOr(cost.total);
}

function piUsageFrom(payload: Record<string, unknown>): Record<string, unknown> {
  const flat = payload.usage;
  if (flat && typeof flat === "object" && !Array.isArray(flat)) return flat as Record<string, unknown>;
  const message = payload.message;
  const nested = message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>).usage
    : undefined;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
}

/// pi's turn counter: the stream closes exactly one `turn_end` per turn, and
/// the turn's usage rides it (the turn's last assistant message, flat or
/// nested). A failed turn still closes with a zeroed usage object, so presence
/// of the usage shape — not a nonzero figure — is what marks a counted turn;
/// a `turn_end` with no usage at all (a stream that only borrows pi's
/// vocabulary) is not a turn pi accounted for.
function piTurnCountFrom(payload: Record<string, unknown>): number | undefined {
  if (payload.type !== "turn_end") return undefined;
  const usage = piUsageFrom(payload);
  const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
    ? usage.cost
    : undefined;
  return cost || usage.totalTokens !== undefined ? 1 : undefined;
}

function numberOr(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export interface RunTokens {
  tokensIn?: number;
  tokensOut?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A run's whole token usage, read the same way `runCostFrom` reads its whole
 * cost: from the one closing receipt a provider states once, at the end.
 * Gated on `type`/`event` being `"result"` rather than trusting field names
 * alone — codex's `turn.completed` reports a per-turn delta under the exact
 * same `input_tokens`/`output_tokens` names, and treating that as a final
 * total would replace the run's tally with just its last turn.
 */
export function runTokensFrom(payload: Record<string, unknown>): RunTokens {
  if (payload.type !== "result" && payload.event !== "result") return {};
  const nested = asRecord(payload.result);
  const usage = asRecord(nested.usage ?? payload.usage);
  const rawIn = numberOr(usage.input_tokens);
  const tokensIn = rawIn === undefined ? undefined : rawIn + Number(usage.cache_creation_input_tokens ?? 0);
  const tokensOut = numberOr(usage.output_tokens);
  return {
    ...(tokensIn === undefined ? {} : { tokensIn }),
    ...(tokensOut === undefined ? {} : { tokensOut }),
  };
}

/**
 * Token deltas for providers whose stream never states a running total: pi
 * closes them on `message_end`, codex on `turn.completed`, opencode on
 * `step_finish` — each once per unit of work, so summing across the run is
 * exact instead of double-counted. pi's `turn_end` is deliberately absent,
 * for the same reason its cost is: the usage riding it is the turn's last
 * message, already counted by that message's own `message_end`.
 */
function incrementalTokensFrom(payload: Record<string, unknown>): RunTokens {
  if (payload.type === "message_end") {
    const usage = piUsageFrom(payload);
    const tokensIn = numberOr(usage.input);
    const tokensOut = numberOr(usage.output);
    return { ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }) };
  }
  if (payload.type === "turn.completed") {
    const usage = asRecord(payload.usage);
    const cached = Number(usage.cached_input_tokens ?? 0);
    const rawIn = numberOr(usage.input_tokens);
    const tokensIn = rawIn === undefined ? undefined : Math.max(0, rawIn - cached);
    const tokensOut = numberOr(usage.output_tokens);
    return { ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }) };
  }
  if (payload.type === "step_finish") {
    const tokens = asRecord(asRecord(payload.part).tokens);
    const tokensIn = numberOr(tokens.input);
    const tokensOut = numberOr(tokens.output);
    return { ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }) };
  }
  return {};
}

/**
 * Rolls a run's token usage the same way `accumulateRunCost` rolls its spend:
 * a final receipt replaces the running total, everything else adds to it. Kept
 * as its own function rather than folded into `accumulateRunCost`'s return
 * shape — `pi-usage.test.ts` pins that function's exact output per event, and
 * every provider that reports tokens also reports the usage fields those
 * assertions were not written to expect.
 */
export function accumulateRunTokens(current: RunTokens, payload: Record<string, unknown>): RunTokens {
  const reported = runTokensFrom(payload);
  if (reported.tokensIn !== undefined || reported.tokensOut !== undefined) return reported;
  const delta = incrementalTokensFrom(payload);
  if (delta.tokensIn === undefined && delta.tokensOut === undefined) return current;
  return {
    tokensIn: (current.tokensIn ?? 0) + (delta.tokensIn ?? 0),
    tokensOut: (current.tokensOut ?? 0) + (delta.tokensOut ?? 0),
  };
}

export function listTasks(archived: TaskListQuery["archived"] = "active"): Task[] {
  return stateStore().listTasks(200, archived);
}

export function listTaskSummaries(query: TaskListQuery = {}): TaskSummary[] {
  return stateStore().listTaskSummaries(query);
}

export function setTaskArchived(id: string, archived: boolean): Task {
  return stateStore().setTaskArchived(id, archived);
}

export interface WorktreeDeleteResult {
  taskId: string;
  /** The checkout: removed by this call, or already gone. */
  checkout: "removed" | "already gone";
  /** The task's branch: left alone, deleted by this call, or already gone. */
  branch: "kept" | "deleted" | "already gone";
}

/**
 * Removes a task's git worktree on demand, without archiving or waiting for
 * cleanup. Only a settled task that ran with `worktree: true` qualifies; a
 * checkout a worker is in, or that a reply would put a worker back into, is
 * refused. The branch survives unless `deleteBranch` says otherwise.
 */
export async function deleteTaskWorktree(
  id: string,
  deleteBranch = false,
): Promise<WorktreeDeleteResult> {
  const task = requireTask(id);
  const worktree = task.worktree;
  if (!worktree) {
    throw new Error(
      `task did not run in a worktree: ${id} — only tasks delegated with worktree: true have a checkout to remove`,
    );
  }
  if (!settled(task.state)) {
    throw new Error(
      `task is still active and holds its worktree: ${id} — state ${task.state}; wait for it to settle before removing the checkout`,
    );
  }
  if (task.state === "needs_input") {
    throw new Error(
      `task is waiting on a reply that would reuse its worktree: ${id} — reply to it or cancel it, then remove the checkout`,
    );
  }
  const checkoutGone = !existsSync(worktree.path);
  await removeTaskWorktree(worktree);
  const branch = deleteBranch ? await removeTaskBranch(worktree) : "kept";
  return { taskId: id, checkout: checkoutGone ? "already gone" : "removed", branch };
}

export function getTask(id: string): Task | undefined {
  return stateStore().getTask(id);
}

/// The event shape the waiter returns, plus what a reader needs to decide
/// whether a row is worth showing: `kind`, the classification `taskEventView`
/// already made, and `minor`, its flag for plumbing. `kind` is always there
/// because every caller has to test it; `minor` only when true, so a caller
/// that renders everything regardless pays nothing for a flag it never reads.
export interface WaitedTaskEvent {
  id: number;
  taskId: string;
  type: string;
  state: Task["state"];
  at: string;
  kind: TaskEventView["kind"];
  summary: string;
  minor?: boolean;
}

export async function waitForTasks(
  taskIds: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  afterCursor?: number,
  until?: WaitUntil,
): Promise<Omit<TaskWaitResult, "events"> & { events: WaitedTaskEvent[] }> {
  const waited = await taskWaiter.wait(taskIds, timeoutMs, signal, afterCursor, until);
  const rows = stateStore().listTaskEventsForTasks(taskIds, afterCursor ?? 0, 101, true);
  const config = await loadConfig();
  const providers = new Map(config.profiles.map(({ id, provider }) => [id, provider]));
  const tasks = new Map(waited.tasks.map((task) => [task.id, task]));
  const events = rows.slice(0, 100).map((event) => {
    const provider = providers.get(tasks.get(event.taskId)?.profileId ?? "");
    const view = provider ? taskEventView(event, provider) : undefined;
    return {
      id: event.id,
      taskId: event.taskId,
      type: event.type,
      state: event.state,
      at: event.createdAt,
      kind: view?.kind ?? "raw",
      summary: view
        ? `${view.title}${view.detail ? `: ${view.detail}` : ""}`.slice(0, 500)
        : event.type,
      ...(view?.minor ? { minor: true } : {}),
    };
  });
  return {
    ...waited,
    cursor: rows.length > 100 ? events.at(-1)?.id ?? waited.cursor : waited.cursor,
    events,
    progress: stateStore().latestTaskProgress(taskIds),
    hasMore: rows.length > 100,
  };
}

/// pi repeats the whole message so far inside every streamed token delta, so a
/// reply of n tokens costs O(n²) to store — a 9-second run measured 827 KB, 91%
/// of it those repeats, and a long one would burn through MAX_EVENTS. The delta
/// itself is what the trace renders, and the assembled message arrives on
/// `message_end`, so the running copy is dropped before the row is written.
export function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== "message_update") return payload;
  const { message: _running, ...rest } = payload;
  const event = rest.assistantMessageEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return rest;
  const { partial: _partial, ...delta } = event as Record<string, unknown>;
  return { ...rest, assistantMessageEvent: delta };
}

interface PiBlock {
  kind: "thinking" | "text";
  text: string;
  lastStoredText: string;
}

/// pi streams one message_update per token — 4,365 thinking_delta rows in a
/// measured 63 s — which would burn the 5,000-event cap in about a minute.
/// The deltas of one block are folded into a buffer and stored once at the
/// block boundary, in the `*_end` shape pi itself uses to close with the whole
/// block in `content`; a block that never ends still surfaces a row each
/// PI_DELTA_FLUSH_MS. A progress flush row carries only new text since the last
/// flush, so a block with N characters flushed K times stores O(N) characters
/// total, not O(N·K). The boundary row carries the entire assembled block.
/// toolcall_* fragments are dropped outright: tool_execution_* already records
/// the call, and a streamed argument token is not row-worthy. The fold keys off
/// the pi provider, never off the shape — a non-pi provider emitting identical
/// lines stores them verbatim.
function foldPiDelta(
  payload: Record<string, unknown>,
  block: PiBlock | undefined,
  lastFlushAt: number,
  now: number,
): { block: PiBlock | undefined; row?: Record<string, unknown> } {
  const event = payload.assistantMessageEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return { block, row: payload };
  const detail = event as Record<string, unknown>;
  const type = typeof detail.type === "string" ? detail.type : "";
  if (!PI_DELTA_TYPES.has(type)) return { block, row: payload };
  const kind: "thinking" | "text" = type.startsWith("thinking") ? "thinking" : "text";
  if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
    return { block };
  }
  if (type === "thinking_delta" || type === "text_delta") {
    const next = block?.kind === kind ? block : { kind, text: "", lastStoredText: "" };
    const text = typeof detail.delta === "string" ? detail.delta : "";
    next.text += text;
    if (now - lastFlushAt >= PI_DELTA_FLUSH_MS) {
      const newText = next.text.slice(next.lastStoredText.length);
      next.lastStoredText = next.text;
      return {
        block: next,
        row: { type: "message_update", assistantMessageEvent: { type: `${kind}_end`, content: newText } },
      };
    }
    return { block: next };
  }
  if (type === "thinking_start" || type === "text_start") {
    return { block: { kind, text: typeof detail.delta === "string" ? detail.delta : "", lastStoredText: "" } };
  }
  // thinking_end / text_end: the boundary row, carrying the whole block.
  const text = block?.kind === kind ? block.text : "";
  return {
    block: undefined,
    row: {
      type: "message_update",
      assistantMessageEvent: {
        type,
        content: text || (typeof detail.content === "string" ? detail.content : ""),
      },
    },
  };
}

export function appendTaskEvent(
  taskId: string,
  type: string,
  state: Task["state"],
  payload: Record<string, unknown>,
): void {
  stateStore().appendTaskEvent(taskId, type, state, payload);
  taskWaiter.notify(taskId);
}

export { needsInputQuestion };

export async function delegate(
  profileId: string,
  prompt: string,
  cwd: string,
  requestedModel?: string,
  parentTaskId?: string,
  options: DelegateOptions = {},
): Promise<Task> {
  const { task, profile, inheritedFrom, autoReads } = await prepareTask(
    profileId,
    prompt,
    cwd,
    requestedModel,
    parentTaskId,
    options,
  );
  try {
    stateStore().createTask(task);
  } catch (error) {
    // The checkout exists before the row does, and nothing else would ever
    // name it again.
    if (task.worktree) await removeTaskWorktree(task.worktree);
    throw error;
  }
  if (options.selection) {
    stateStore().recordTaskSelection(task.id, {
      ...options.selection,
      chosen: {
        profileId: task.profileId,
        model: task.model,
        ...(task.effort ? { effort: task.effort } : {}),
      },
    });
  }
  if (autoReads?.length) {
    appendTaskEvent(task.id, "scope_auto_completed", task.state, {
      added: autoReads,
      reason: "paths named in the prompt were missing from the stated read scope",
    });
  }
  // Record and flag, never block: the caller stated no scope and this cwd has
  // none on file, so the run gets whole-tree access and says so out loud.
  if (!task.grantId) {
    appendTaskEvent(task.id, "scope_ungranted", task.state, {
      scope: task.scope,
      reason: "no scope stated and no grant on file for this cwd; defaulted to the whole working tree",
    });
  } else if (inheritedFrom) {
    appendTaskEvent(task.id, "scope_inherited", task.state, {
      scope: task.scope,
      approvedFor: inheritedFrom,
      usedBy: profileId,
      reason: `scope was approved for profile ${inheritedFrom}, not ${profileId}`,
    });
  }
  launchTask(task, profile);
  return task;
}

/** Set when a task reused a scope the user approved for a different destination. */
export function scopeInheritanceWarning(task: Task): string | undefined {
  // Newest wins: a handoff inherits again, onto a different destination than
  // the one the first event named.
  const event = [...stateStore().listTaskEvents(task.id)].reverse()
    .find(({ type }) => type === "scope_inherited");
  if (!event) return undefined;
  return `${task.profileId} inherited a scope approved for ${event.payload.approvedFor}; state scope explicitly to approve this destination`;
}

async function prepareTask(
  profileId: string,
  prompt: string,
  cwd: string,
  requestedModel?: string,
  parentTaskId?: string,
  options: DelegateOptions = {},
): Promise<{ task: Task; profile: Profile; inheritedFrom?: string; autoReads?: string[] }> {
  const workspace = await validateWorkspace(cwd);
  // A `[worker]` table Inter cannot read fails the dispatch rather than the run,
  // so the caller hears about it before a task row and a provider session exist.
  await loadWorkerRules(workspace);
  // First delegate into a cwd the map does not know builds it — bounded by the
  // build's own budget, never a dispatch blocker.
  ensureContextMap(workspace);
  // The effective profile set for this workspace: a project file that narrows
  // the list binds here, so a profile it dropped is not dispatachable.
  const config = await loadConfig(workspace);
  const profile = config.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(unknownProfileMessage(profileId, config.profiles));
  if (!profile.enabled) throw new Error(`profile disabled: ${profileId}`);
  const model = requestedModel?.trim() || profile.model;
  if (model.length > 200) throw new Error("model exceeds 200 characters");
  // parent_task_id is a foreign key, so an unknown id would otherwise surface as a
  // raw SQLite constraint failure after the caller already committed to the work.
  if (parentTaskId && !stateStore().getTask(parentTaskId)) {
    throw new Error(`unknown parent task: ${parentTaskId}`);
  }
  const timeoutMs = options.timeoutMs;
  validateTimeoutMs(timeoutMs);

  const now = new Date().toISOString();
  const granted = resolveScope(workspace, profileId, options.scope, prompt);
  const id = crypto.randomUUID();
  // Only the run moves into the checkout: the grant resolved above, and the
  // memories and map read at launch, all stay on the cwd the caller named.
  const checkout = options.worktree ? await createTaskWorktree(workspace, id) : undefined;
  const task: Task = {
    id,
    profileId,
    model,
    prompt,
    cwd: checkout?.cwd ?? workspace,
    ...(checkout ? { worktree: checkout.worktree } : {}),
    state: "queued",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: granted.scope,
    ...(granted.grantId ? { grantId: granted.grantId } : {}),
    allowQuestions: options.allowQuestions !== false,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.tldr ? { tldr: options.tldr } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
  return {
    task,
    profile,
    ...(granted.inheritedFrom ? { inheritedFrom: granted.inheritedFrom } : {}),
    ...(granted.autoReads?.length ? { autoReads: granted.autoReads } : {}),
  };
}

/**
 * A stated scope becomes a grant on this cwd; a later call that states none
 * reuses it. Falling back to the whole tree only happens when nothing was ever
 * approved here, which makes the laziest call the narrowest one available
 * rather than the widest.
 */
function resolveScope(
  workspace: string,
  profileId: string,
  requested?: TaskScope,
  prompt?: string,
): { scope: TaskScope; grantId?: string; inheritedFrom?: string; autoReads?: string[] } {
  const store = stateStore();
  if (requested) {
    // Callers forget paths their own prompt names; a worker that EPERMs on one
    // of those reads burns the run working around a grant the caller clearly
    // meant. Reads only — "never touch secrets.env" must not grant its write.
    const stated = normalizeTaskScope(requested, workspace);
    const autoReads = promptReadPaths(prompt ?? "", workspace)
      .filter((path) => !scopeCoversPath(stated.read, workspace, path));
    const scope = autoReads.length
      ? normalizeTaskScope({ read: [...stated.read, ...autoReads], write: stated.write }, workspace)
      : stated;
    return { scope, grantId: store.recordScopeGrant(workspace, profileId, scope).id, ...(autoReads.length ? { autoReads } : {}) };
  }
  const existing = store.latestScopeGrant(workspace, profileId);
  if (existing) {
    store.touchScopeGrant(existing.id);
    return {
      scope: existing.scope,
      grantId: existing.id,
      // Approval names a destination, not just a folder. Reusing a scope the
      // user approved for a different provider is allowed but never silent.
      ...(existing.profileId && existing.profileId !== profileId
        ? { inheritedFrom: existing.profileId }
        : {}),
    };
  }
  return { scope: normalizeTaskScope(undefined, workspace) };
}

/**
 * A settled run's writes fold into the project's map. A worktree run's writes
 * are in its own checkout, so folding them would record, against the project,
 * content the project's tree does not have.
 */
function foldContext(task: Pick<Task, "cwd" | "worktree" | "id">): void {
  if (task.worktree) return;
  queueContextFold(task.cwd, task.id);
}

/** A dead-end id should say where the live ones are listed. */
export function unknownTaskMessage(taskId: string): string {
  return `unknown task: ${taskId} — call tasks to list recent task ids`;
}

function unknownProfileMessage(profileId: string, profiles: Profile[]): string {
  const known = profiles.filter(({ enabled }) => enabled).map(({ id }) => id);
  return known.length > 0
    ? `unknown profile: ${profileId} — enabled profiles are ${known.join(", ")}`
    : `unknown profile: ${profileId} — no profiles are enabled`;
}

async function validateWorkspace(cwd: string): Promise<string> {
  const workspace = resolve(cwd);
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  // Default to the whole home directory, matching the app's launch env: the
  // broker is often spawned inside one project, and delegation must reach any
  // of the user's repos. Set INTER_ROOTS to narrow the fence.
  const roots = (Bun.env.INTER_ROOTS ?? homedir())
    .split(":")
    .filter(Boolean)
    .map((root) => resolve(root));
  if (!roots.some((root) => {
    const child = relative(root, workspace);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  })) {
    throw new Error(
      `cwd is outside INTER_ROOTS: ${workspace} (roots: ${roots.join(", ")}); set the INTER_ROOTS env var to allow more roots`,
    );
  }
  if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) throw new Error("cwd does not exist");
  return workspace;
}

function launchTask(
  task: Task,
  profile: Profile,
  resumeSessionId?: string,
  promptOverride?: string,
): void {
  void runTask(task, profile, resumeSessionId, promptOverride);
}

async function runTask(
  task: Task,
  profile: Profile,
  resumeSessionId?: string,
  promptOverride?: string,
): Promise<void> {
  if (!update(task, { state: "running" }, ["queued"])) return;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let active: ActiveWorker | undefined;
  let scratchDir: string | undefined;
  // Declared out here so the finally block can bank it: the provider has
  // already charged for whatever this run reported, however the run ends.
  let runCost: { costUsd?: number; turns?: number } = {};
  let runTokens: RunTokens = {};
  try {
    scratchDir = mkdtempSync(resolve(tmpdir(), "inter-worker-"));
    const hookUrl = `${Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`}/api/hooks/${task.id}`;
    const project = projectCwd(task);
    const worktree = requireTaskWorktree(task);
    // The map is an accelerator; a project that wrote a broken `[map]` table
    // ships today's behaviour rather than a failed run.
    const mapConfig = await loadMapConfig(project).catch(() => DEFAULT_MAP_CONFIG);
    const rules = await loadWorkerRules(project);
    const buildPrompt = (source: string) => workerPrompt(
      contextMapSection(
        promptWithMemories(source, stateStore().listMemories(project)),
        task,
        // The map is built from the project's working tree, which a worktree
        // run is not in: its checkout is HEAD, and the map would describe the
        // user's uncommitted edits as if the worker could see them.
        task.worktree ? { ...mapConfig, ship: false, lookup: false } : mapConfig,
      ),
      task.allowQuestions,
      task.scope,
      rules,
    );
    // The caller's prompt is only part of what leaves the machine; store the
    // real text so "what was sent to this provider" is answerable later.
    const shipPrompt = (source: string) => {
      const prompt = buildPrompt(source);
      stateStore().recordShippedPrompt(task.id, prompt);
      task.shippedPrompt = prompt;
      return prompt;
    };
    let prompt = shipPrompt(promptOverride ?? task.prompt);
    const env = {
      ...Bun.env,
      // The CLI runs on the same PATH the broker used to find it, so its own
      // subprocesses (git, version shims) see the directories the user's shell
      // has rather than the broker's startup snapshot. Placed ahead of the
      // profile so an explicitly configured PATH still wins.
      PATH: workerPath(),
      ...profileEnv(profile),
      // Bun.spawn sets the real working directory but leaves PWD inherited from
      // whatever shell launched the broker. Workers that trust PWD over getcwd
      // (opencode stats it at startup) would probe that directory and take an
      // EPERM from the sandbox, so the task cwd is the only directory a worker
      // ever learns about.
      PWD: task.cwd,
      OLDPWD: task.cwd,
      // OpenCode shells out to Git while locating the project root. Reading a
      // user's global Git config is outside delegated scope and may follow
      // arbitrary include paths, so project discovery uses repository-local
      // metadata only.
      ...(profile.provider === "opencode" ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
      TMPDIR: scratchDir,
      INTER_TASK_ID: task.id,
      INTER_HOOK_URL: hookUrl,
    };
    const startedAt = Date.now();
    // Liveness is pipe activity, not stored rows: a run that emits bytes but
    // stores nothing (capture stopped, unparseable lines) is working, and a
    // clock only the storage path advanced misreported pi's truncated runs as
    // stalled for minutes.
    let lastPipeActivityAt = startedAt;
    let eventCount = 0;
    let eventCaptureStopped = false;
    let oversizedLine = false;
    const flaggedWrites = new Set<string>();
    let resumeWith = resumeSessionId;
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let bootstrapRetries = 0;
    let resumeSessionConfirmed = false;
    let resumeSessionMismatch: string | undefined;
    while (true) {
      const command = resumeWith
        ? resumeCommandFor(profile, prompt, task.cwd, resumeWith, task.model, hookUrl, task.effort)
        : commandFor(profile, prompt, task.cwd, task.model, hookUrl, task.effort);
      const child = Bun.spawn(sandboxedCommand(command, task.cwd, task.scope, profile, scratchDir, worktree), {
        cwd: task.cwd,
        detached: true,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (active) {
        active.child = child;
      } else {
        active = { task, child, cancelled: false };
        activeWorkers.set(task.id, active);
        if (task.timeoutMs) {
          active.timeout = setTimeout(() => {
            void cancelTask(task.id, `task exceeded timeoutMs ${task.timeoutMs}`, true);
          }, task.timeoutMs);
        }
        heartbeat = setInterval(() => {
          const silentMs = Date.now() - lastPipeActivityAt;
          appendTaskEvent(task.id, "heartbeat", task.state, {
            elapsedMs: Date.now() - startedAt,
            silentMs,
            stalled: silentMs >= 30_000,
          });
        }, 10_000);
      }
      // Stamp the row before reading a byte of output. The child is detached, so
      // from here it can outlive this broker; if the broker dies in the next
      // instant, this stamp is the only way its successor can tell that the
      // process is still out there writing to the user's tree.
      const identity = captureWorkerIdentity(child.pid);
      stateStore().recordTaskWorker(task.id, identity);
      appendTaskEvent(task.id, "worker_spawned", task.state, {
        provider: profile.provider,
        model: task.model,
        pid: child.pid,
        ...(identity ? {} : { workerIdentity: "unavailable" }),
        ...(resumeWith ? { resumedSession: resumeWith } : {}),
      });
      let attemptEvents = 0;
      // pi's fold state lives per attempt: a respawned child starts with an
      // empty buffer and a fresh flush clock.
      let piBlock: PiBlock | undefined;
      let lastPiFlushAt = Date.now();
      [stdout, stderr, exitCode] = await Promise.all([
        // Any byte on stdout is the worker alive; stderr is not hooked because
        // it is never parsed and these CLIs write it rarely.
        readStream(child.stdout, (line) => {
          if (eventCaptureStopped) return;
          if (eventCount >= MAX_EVENTS) {
            appendTaskEvent(task.id, "events_truncated", task.state, { limit: MAX_EVENTS });
            eventCaptureStopped = true;
            return;
          }
          // A line over MAX_EVENT_LINE still reaches the shared bound at
          // write time (store.ts's addTaskEvent, via boundEventPayload) —
          // truncated there, not dropped here. `oversizedLine` only feeds
          // the bootstrap-retry guard below: seeing one confirms the worker
          // was producing real output, so a nonzero exit isn't a fresh
          // bootstrap failure.
          if (line.length > MAX_EVENT_LINE) oversizedLine = true;
          // Only the parse is expected to fail: a provider can print
          // anything, and a bad line costs that line alone. Everything after
          // it is deliberate work — a failed event write is a real fault,
          // and swallowing it would truncate the log with no signal anywhere.
          // Let it throw to runTask's catch.
          let payload: Record<string, unknown>;
          try {
            const parsed = JSON.parse(line) as unknown;
            payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { value: parsed };
          } catch {
            return;
          }
          const kind = typeof payload.type === "string" ? payload.type : "event";
          if (profile.provider === "pi" && kind === "message_update") {
            const folded = foldPiDelta(payload, piBlock, lastPiFlushAt, Date.now());
            piBlock = folded.block;
            if (!folded.row) return;
            payload = folded.row;
            lastPiFlushAt = Date.now();
          }
          appendTaskEvent(task.id, `agent.${kind}`, task.state, compactPayload(payload));
          // A run's spend arrives either once, near the end, as a receipt that
          // replaces the total (claude's `total_cost_usd` on `result`), or — on
          // pi — as one `usage.cost.total` per `message_end`, which adds to it,
          // while each `turn_end` counts one turn.
          runCost = accumulateRunCost(runCost, payload);
          runTokens = accumulateRunTokens(runTokens, payload);
          eventCount++;
          attemptEvents++;
          // The sandbox refuses out-of-scope writes inside the worker, where
          // the trace never sees a failure row; flag the refusal here so the
          // stream carries an explicit marker instead of implying success.
          for (const target of writeTargetsFrom(payload)) {
            const refused = scopeRefusedWrite(target, task.cwd, task.scope, scratchDir);
            if (!refused || flaggedWrites.has(refused)) continue;
            flaggedWrites.add(refused);
            appendTaskEvent(task.id, "scope_refusal", task.state, {
              path: refused,
              error: `${refused} is outside the granted write scope; the sandbox refuses this write`,
            });
          }
          const sessionId = sessionIdFrom(profile.provider, payload);
          if (sessionId) {
            if (resumeWith) {
              if (sessionId !== resumeWith && !resumeSessionMismatch) {
                resumeSessionMismatch = sessionId;
                appendTaskEvent(task.id, "resume_session_mismatch", task.state, {
                  expectedSession: resumeWith,
                  actualSession: sessionId,
                });
                killProcessGroup(child, "SIGTERM");
                // A provider that forked is holding the wrong session; bound the
                // stop so one that ignores SIGTERM cannot strand the run.
                const activeRun = activeWorkers.get(task.id);
                if (activeRun) {
                  activeRun.forceKill = setTimeout(
                    () => killProcessGroup(child, "SIGKILL"),
                    FORCE_KILL_GRACE_MS,
                  );
                }
              } else if (sessionId === resumeWith && !resumeSessionConfirmed) {
                resumeSessionConfirmed = true;
                appendTaskEvent(task.id, "session_reused", task.state, {
                  provider: profile.provider,
                  sessionId,
                });
              }
              return;
            }
            const store = stateStore();
            if (!task.sessionId) {
              if (store.captureTaskSessionId(task.id, profile.provider, sessionId)) {
                task.sessionId = sessionId;
                taskWaiter.notify(task.id);
              } else {
                task.sessionId = store.getTask(task.id)?.sessionId;
              }
            }
          }

        }, MAX_OUTPUT, () => { lastPipeActivityAt = Date.now(); }),
        readStream(child.stderr, undefined, MAX_EVENT_LINE),
        child.exited,
      ]);
      if (resumeSessionMismatch) break;
      const retryReason = antigravityBootstrapRetryReason(
        profile.provider,
        bootstrapRetries,
        task.sessionId,
        attemptEvents,
        stdout,
      );
      if (
        exitCode !== 0 && !resumeWith && !profile.command && !oversizedLine &&
        !eventCaptureStopped && retryReason && !active.cancelled &&
        stateStore().getTask(task.id)?.state !== "cancelled"
      ) {
        bootstrapRetries++;
        appendTaskEvent(task.id, "provider_retry", task.state, {
          provider: profile.provider,
          attempt: bootstrapRetries + 1,
          maxAttempts: MAX_ANTIGRAVITY_BOOTSTRAP_RETRIES + 1,
          error: retryReason,
        });
        await Bun.sleep(bootstrapRetries * 1_000);
        if (active.cancelled || stateStore().getTask(task.id)?.state === "cancelled") return;
        continue;
      }
      // A resume the provider refused outright — nonzero exit, not a byte of
      // streamed work — is a session it cannot reopen. Account-level failures
      // (rate limit, auth, billing, network) would fail a fresh session the same
      // way and keep their own classification; only a generic refusal is the
      // shape a hard kill leaves behind. Start a fresh session under the same
      // task id, seeded with the original prompt and the prior run's context
      // rebuilt from Inter's own rows.
      if (
        resumeWith && exitCode !== 0 && attemptEvents === 0 &&
        !active.cancelled && stateStore().getTask(task.id)?.state !== "cancelled" &&
        classifyFailure(`${stderr}\n${stdout}`) === "worker_error"
      ) {
        const priorEvents = stateStore().listTaskEvents(task.id);
        appendTaskEvent(task.id, "resume_failed", task.state, {
          resumedSession: resumeWith,
          exitCode,
          error: stderr.trim().slice(0, 500),
        });
        const ending = priorRunEnding(priorEvents);
        const brief = handoffBrief({ ...task, ...ending }, priorEvents, profile.provider, {
          sameAccount: true,
          instruction: ending.instruction,
        });
        appendTaskEvent(task.id, "resume_fallback", task.state, {
          resumedSession: resumeWith,
          tier: brief.tier,
          chars: brief.chars,
        });
        promptOverride = brief.prompt;
        prompt = shipPrompt(promptOverride);
        // The stored session is the dead one; a fresh run must capture its own
        // or every later resume retries the session that just refused to open.
        stateStore().clearCapturedSession(task.id);
        task.sessionId = undefined;
        resumeWith = undefined;
        continue;
      }
      break;
    }
    if (active?.cancelled || stateStore().getTask(task.id)?.state === "cancelled") return;
    if (resumeSessionMismatch) {
      const message = "provider resumed a different root session";
      update(task, {
        state: "failed",
        error: message,
        completion: { blocked: true, code: "worker_error", reason: message },
      }, ["running"]);
      return;
    }
    const output = finalText(profile, stdout);
    // Only the raw stream knows the turn died mid-generation; the final text it
    // left behind is indistinguishable from a worker that just never signed off.
    const outcome = interpretWorkerOutcome(exitCode, output, stderr, abortedTurn(stdout));
    // A worker that dies during startup prints its real error as a stream
    // event, not on stderr; without this the task surfaces only "exit 1".
    if (outcome.state === "failed" && !stderr.trim()) {
      const hint = lastWorkerErrorDetail(task.id, profile.provider);
      const unhelpful = outcome.error === `exit ${exitCode}` || /^[{[]/.test(outcome.error ?? "");
      const better = hint.error ?? (unhelpful ? hint.last : undefined);
      if (better) {
        outcome.error = better;
        outcome.completion.reason = better.replace(/\s+/g, " ").trim().slice(0, 500);
      }
    }
    // When the window clears is what tells the caller whether to wait and resume
    // this session — free and lossless — or hand the task to another account
    // now. The provider states it on the failing message, in the stream, or
    // both; without it the choice cannot be made at all.
    if (outcome.completion.code === "rate_limit" && !outcome.completion.resetsAt) {
      const resetsAt = rateLimitResetAt(`${outcome.error ?? ""}\n${output}`)
        ?? rateLimitResetFromEvents(task.id);
      if (resetsAt) outcome.completion.resetsAt = resetsAt;
    }
    const persisted = update(task, {
      state: outcome.state,
      output: outcome.output,
      ...(outcome.question ? { question: outcome.question } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      completion: withUnverifiedEvidence(task, withScopeSuggestion(task, outcome.completion)),
    }, ["running"]);
    if (!persisted) return;
    recordProfileTaskOutcome(stateStore(), task.profileId, outcome, task.model);
    recordActualEffort(task, profile);
  } catch (error) {
    // A throw from the stream handler abandons a worker mid-flight: its pipe
    // reader is gone, so it would block on a full buffer forever. The cancel
    // path kills the child for the same reason.
    if (active?.child) killProcessGroup(active.child, "SIGTERM");
    if (!active?.cancelled && stateStore().getTask(task.id)?.state !== "cancelled") {
      const message = String(error);
      update(task, {
        state: "failed",
        error: message,
        completion: { blocked: true, code: "worker_error", reason: message },
      }, ["running"]);
    }
  } finally {
    // Every exit lands here: clean finish, cancel during a retry backoff, or a
    // thrown spawn error. Anywhere else and a run the provider already billed
    // for reports no spend at all.
    stateStore().recordTaskCost(task.id, runCost.costUsd, runCost.turns, runTokens.tokensIn, runTokens.tokensOut);
    // The child is done, so its identity must not outlive it: the pid is now
    // free for the OS to hand to someone else, and a stale stamp is exactly
    // what would make the next boot probe a stranger's process.
    stateStore().recordTaskWorker(task.id, undefined);
    if (heartbeat) clearInterval(heartbeat);
    if (active?.timeout) clearTimeout(active.timeout);
    if (active?.forceKill) clearTimeout(active.forceKill);
    if (activeWorkers.get(task.id) === active) activeWorkers.delete(task.id);
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function antigravityBootstrapRetryReason(
  provider: Profile["provider"],
  retries: number,
  sessionId: string | undefined,
  attemptEvents: number,
  stdout: string,
): string | undefined {
  if (
    provider !== "antigravity" || retries >= MAX_ANTIGRAVITY_BOOTSTRAP_RETRIES ||
    sessionId || attemptEvents !== 1
  ) return undefined;
  for (const line of stdout.trimEnd().split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event !== "result") continue;
      const result = event.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
      const value = result as Record<string, unknown>;
      if (
        value.status !== "ERROR" || value.num_turns !== 0 || value.conversation_id !== ""
      ) return undefined;
      const error = typeof value.error === "string" ? value.error : "";
      if (
        !/eligibility check failed: failed to get profile picture/i.test(error) ||
        !/(?:no route to host|i\/o timeout|connection timed out|temporary failure|connection reset)/i.test(error)
      ) return undefined;
      return error.replace(/\s+/g, " ").trim().slice(0, 500);
    } catch {}
  }
  return undefined;
}

// `unverified` and `failed` look identical in a task list — both are blocked
// with a reason string — but an unverified run may have finished the work and
// only skipped the sign-off. Naming the write scope turns "go read the log" into
// "go look here" for the coordinator deciding whether to trust it or redo it.
export function withUnverifiedEvidence(task: Task, completion: Task["completion"]): Task["completion"] {
  if (!completion || completion.code !== "unverified") return completion;
  const where = task.scope.write.includes("**") ? task.cwd : task.scope.write.join(", ") || task.cwd;
  return { ...completion, reason: `${completion.reason}; check ${where} for finished work before redoing it` };
}

// A permission_denied task knows exactly which paths killed it: the events
// recorded them. Hand the caller a scope that would have survived so resume
// is an approval, not a log-reading exercise.
function withScopeSuggestion(task: Task, completion: Task["completion"]): Task["completion"] {
  if (!completion || completion.code !== "permission_denied") return completion;
  const payloads = stateStore().listTaskEvents(task.id)
    .map((event) => JSON.stringify(event.payload));
  const { reads, writes } = deniedScopePaths(payloads, task.cwd);
  const read = [...task.scope.read, ...reads.filter((path) => !scopeCoversPath(task.scope.read, task.cwd, path))];
  const write = [...task.scope.write, ...writes.filter((path) => !scopeCoversPath(task.scope.write, task.cwd, path))];
  const suggestedScope = normalizeTaskScope({
    read: reads.length ? read : [...read, "**"],
    write,
  }, task.cwd);
  const changed = suggestedScope.read.length !== task.scope.read.length ||
    suggestedScope.write.length !== task.scope.write.length;
  return changed ? { ...completion, suggestedScope } : completion;
}

function lastWorkerErrorDetail(
  taskId: string,
  provider: Profile["provider"],
): { error?: string; last?: string } {  const events = stateStore().listTaskEvents(taskId);
  let last: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (!event.type.startsWith("agent.")) continue;
    const view = taskEventView(event, provider);
    const detail = view.detail?.trim();
    if (!detail) continue;
    const text = `${view.title}: ${detail}`;
    if (view.kind === "error" || view.phase === "failed") return { error: text, last: last ?? text };
    last ??= text;
  }
  return { last };
}

/**
 * Records the reasoning level the provider session actually ran at, read back
 * from the session store now the run is over, and flags a mismatch against the
 * level that was requested. Absent when the provider does not record a level:
 * that is unknown, never a guess at the requested value.
 */
export function recordActualEffort(task: Task, profile: Profile): void {
  if (!task.sessionId) return;
  const actual = sessionEffortFrom(profile.provider, task.sessionId, profile);
  if (actual === undefined) return;
  stateStore().recordTaskEffortActual(task.id, actual);
  if (task.effort && task.effort !== actual) {
    appendTaskEvent(task.id, "effort_mismatch", task.state, {
      requested: task.effort,
      actual,
    });
  }
}

export function recordProfileTaskOutcome(
  store: Pick<StateStore, "clearProfileFailure" | "recordProfileFailure">,
  profileId: string,
  outcome: ReturnType<typeof interpretWorkerOutcome>,
  model?: string,
): void {
  if (outcome.state === "completed") {
    store.clearProfileFailure(profileId, model);
    return;
  }
  if (outcome.state !== "failed") return;
  const { code } = outcome.completion;
  if (code !== "auth" && code !== "billing" && code !== "rate_limit" && code !== "network") return;
  store.recordProfileFailure(
    profileId,
    code,
    outcome.completion.reason ?? outcome.error ?? "provider failure",
    // The provider said when it will answer again; the ten-minute guess this
    // otherwise falls back to is what made a five-hour window look retryable.
    outcome.completion.resetsAt,
    // Which model was metered. A rate limit read as the account's would take
    // every other model on it out of service too.
    code === "rate_limit" ? model : undefined,
  );
}

/**
 * Claude's stream states the window boundary outright — `rate_limit_event` with
 * `resetsAt` in epoch seconds — often minutes before the limit actually bites.
 * When the failing message names no time, that event is the only record left.
 */
function rateLimitResetFromEvents(taskId: string): string | undefined {
  const events = stateStore().listTaskEvents(taskId);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "agent.rate_limit_event") continue;
    const info = event.payload.rate_limit_info;
    if (!info || typeof info !== "object" || Array.isArray(info)) continue;
    const seconds = Number((info as Record<string, unknown>).resetsAt);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const at = new Date(seconds * 1_000);
    return at.getTime() > Date.now() ? at.toISOString() : undefined;
  }
  return undefined;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  outputLimit = MAX_OUTPUT,
  onBytes?: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > 0) onBytes?.();
    const text = decoder.decode(value, { stream: true });
    output = tail(output + text, outputLimit);
    carry += text;
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) if (line) onLine?.(line);
    if (carry.length > MAX_EVENT_LINE) carry = "";
  }
  carry += decoder.decode();
  if (carry) onLine?.(carry);
  return output;
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit);
}

/**
 * The states a dead run can be continued from. The store pins the same set in
 * SQL on the write itself; this is the copy the entry points check, stated once
 * so `resume` and `handoff` cannot drift apart.
 */
// `pending` is resumable on purpose: resuming a held task is "start now" — it
// drops the hold and replays the stored resume immediately.
const RESUMABLE_STATES: Task["state"][] = ["failed", "cancelled", "blocked", "pending"];

/**
 * What the run being continued ended in, read off the events because `resume`
 * has already cleared it from the row: the state it was resumed from, the
 * settled event's failure fields, and the caller's stored instruction. The
 * fresh-session fallback ships all of it to the next worker, because a session
 * reboot must not lose the reason the resume exists or what it is continuing.
 */
export function priorRunEnding(events: TaskEvent[]): {
  state?: Task["state"];
  error?: string;
  question?: string;
  completion?: Task["completion"];
  instruction?: string;
} {
  let ending: { state?: Task["state"]; error?: string; question?: string; completion?: Task["completion"] } = {};
  let instruction: string | undefined;
  for (const event of events) {
    if (event.type === "resumed") {
      if (typeof event.payload.previousState === "string") {
        ending.state = event.payload.previousState as Task["state"];
      }
      if (typeof event.payload.instruction === "string") {
        instruction = event.payload.instruction;
      }
    } else if (
      event.type === "failed" || event.type === "cancelled" ||
      event.type === "blocked" || event.type === "needs_input"
    ) {
      if (typeof event.payload.error === "string") ending.error = event.payload.error;
      if (typeof event.payload.question === "string") ending.question = event.payload.question;
      const completion = event.payload.completion;
      if (completion && typeof completion === "object" && !Array.isArray(completion)) {
        ending.completion = completion as Task["completion"];
      }
    }
  }
  return { ...ending, ...(instruction ? { instruction } : {}) };
}

function requireTask(id: string): Task {
  const task = stateStore().getTask(id);
  if (!task) throw new Error(unknownTaskMessage(id));
  return task;
}

/**
 * A task that exists and is in a state a continuation verb can act on. `verb`
 * names the operation in the refusal, which is the only thing `resume` and
 * `handoff` legitimately differ on here.
 *
 * `resume` also takes a completed task, but only one carrying an instruction:
 * the session is what makes a follow-up cheap, and a completed run re-entered
 * with nothing new to do would spend a turn repeating itself. `handoff` has no
 * such path — it rebuilds a brief for a run that died, and this one did not.
 */
function requireContinuableTask(
  id: string,
  verb: "resumed" | "handed off",
  instruction?: string,
): Task {
  const task = requireTask(id);
  if (verb === "resumed" && task.state === "completed") {
    if (instruction?.trim()) return task;
    throw new Error(
      `task ${id} cannot be resumed without an instruction — it already finished, so there is nothing to retry; say what to do next in instruction`,
    );
  }
  if (!RESUMABLE_STATES.includes(task.state)) {
    throw new Error(`task cannot be ${verb} from state ${task.state}: ${id}`);
  }
  return task;
}

/**
 * The profile a continuation will reopen the session on, proven able to reopen
 * it. The structural limitation is checked before the missing session id: a
 * profile that can never capture a session would otherwise surface the
 * misleading "no captured session" message. `hint` is the tail of that message
 * for the caller that has more to say about it.
 */
async function requireSessionProfile(
  task: Task,
  verb: "reply to" | "resume",
  hint = "",
): Promise<Profile> {
  const profile = (await loadConfig(projectCwd(task))).profiles.find((item) => item.id === task.profileId);
  if (!profile || !canResumeSession(profile)) {
    throw new Error(sessionResumeUnsupported(task.profileId, profile));
  }
  if (!task.sessionId) {
    throw new Error(`task has no captured session to ${verb}: ${task.id}${hint}`);
  }
  return profile;
}

export async function reply(
  id: string,
  answer: string,
  options: ReplyOptions = {},
): Promise<Task> {
  const old = requireTask(id);
  if (old.state !== "needs_input") {
    throw new Error(old.state === "blocked"
      ? `task does not need input: ${id} — state is blocked; use resume with your answer as the instruction`
      : `task does not need input: ${id} (state: ${old.state})`);
  }
  requireTaskWorktree(old);
  const profile = await requireSessionProfile(old, "reply to");
  const prompt = continuationPrompt(
    old.prompt,
    old.question ?? "What input is required?",
    answer,
  );
  // A replacement scope is a fresh statement of what this cwd may touch, so it
  // becomes the grant later delegations inherit.
  const replacement = options.scope ? resolveScope(projectCwd(old), old.profileId, options.scope) : undefined;
  const task = stateStore().answerTask(id, {
    answer,
    ...(replacement ? { scope: replacement.scope } : {}),
    ...(replacement?.grantId ? { grantId: replacement.grantId } : {}),
  });
  taskWaiter.notify(id);
  launchTask(task, profile, old.sessionId, prompt);
  return task;
}

/**
 * States where a follow-up waits instead of running: a worker is on this task
 * right now, or is about to be. `needs_input` is deliberately absent — that run
 * is waiting on a person, and `reply` is the way back into it.
 */
const WORKING_STATES: Task["state"][] = ["queued", "pending", "running", "answered"];

export async function resumeTask(
  id: string,
  instruction?: string,
  options: ResumeOptions = {},
): Promise<Task> {
  if (options.queue === "clear") {
    const task = requireTask(id);
    stateStore().clearFollowUps(id, task.state, "removed on request");
    return requireTask(id);
  }
  if (options.queue === "add") {
    const task = requireTask(id);
    if (WORKING_STATES.includes(task.state)) return queueFollowUp(task, instruction, options);
  }
  const old = requireContinuableTask(id, "resumed", instruction);
  requireTaskWorktree(old);
  // A held resume replays only its stored instruction when the hold releases,
  // and a queued follow-up is only an instruction — either one would silently
  // drop a stated model or effort, so both are refused up front.
  const runSettings = (["model", "effort"] as const).filter((key) => options[key] !== undefined);
  if (options.startAt && runSettings.length > 0) {
    throw new Error(
      `a held resume replays its instruction only: ${id} — ${runSettings.join(" and ")} now would be dropped when the hold releases; resume without startAt to change them`,
    );
  }
  const model = options.model?.trim() || old.model;
  if (model.length > 200) throw new Error("model exceeds 200 characters");
  const effort = options.effort?.trim();
  const profile = await requireSessionProfile(
    old,
    "resume",
    " — the worker exited before the provider created a session; delegate a fresh task instead",
  );
  validateTimeoutMs(options.timeoutMs);
  if (options.startAt) return armResumeHold(old, instruction?.trim(), options.startAt);
  // A resume on a held task is its force-start: drop the hold and run now.
  if (old.state === "pending") {
    stateStore().dropTaskHold(id, "hold_released", { forced: true });
  }
  // A replacement scope is a fresh statement of what this cwd may touch, so it
  // becomes the grant later delegations inherit.
  const replacement = options.scope ? resolveScope(projectCwd(old), old.profileId, options.scope) : undefined;
  const followUp = old.state === "completed";
  const given = instruction?.trim();
  const resumeInstruction = given || "Continue the original task from where the previous run stopped.";
  const prompt = [
    followUp ? "# Follow-up instruction" : "# Resume instruction",
    resumeInstruction,
    "",
    followUp
      ? "Your earlier run on this task finished. This is a follow-up in that same session: keep what you already read and decided, and do the work above without re-deriving the project from scratch."
      : `The previous Inter run ended in state \`${old.state}\`. Continue the existing provider session without repeating completed work.`,
  ].join("\n");
  const task = stateStore().resumeTask(id, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(model !== old.model ? { model } : {}),
    ...(effort && effort !== old.effort ? { effort } : {}),
    ...(replacement ? { scope: replacement.scope } : {}),
    ...(replacement?.grantId ? { grantId: replacement.grantId } : {}),
    ...(options.allowQuestions !== undefined ? { allowQuestions: options.allowQuestions } : {}),
    ...(given ? { instruction: given } : {}),
  });
  taskWaiter.notify(id);
  launchTask(task, profile, old.sessionId, prompt);
  return task;
}

/**
 * Stores a follow-up on a task a worker is still on. Everything else `resume`
 * accepts describes a run — when it starts, what it may touch, how long it gets
 * — and a queued item is only an instruction, so passing one of those together
 * with the queue is a caller who means two different things at once.
 */
function queueFollowUp(task: Task, instruction: string | undefined, options: ResumeOptions): Task {
  const given = instruction?.trim();
  if (!given) {
    throw new Error(
      `a queued follow-up needs an instruction: ${task.id} — say what the worker should do once its current run lands`,
    );
  }
  const conflicting = (["startAt", "scope", "timeoutMs", "allowQuestions", "model", "effort"] as const)
    .filter((key) => options[key] !== undefined);
  if (conflicting.length > 0) {
    throw new Error(
      `a queued follow-up takes only an instruction: ${task.id} — remove ${conflicting.join(", ")}; those settings belong on the resume that starts a run`,
    );
  }
  stateStore().queueFollowUp(task.id, task.state, given);
  taskWaiter.notify(task.id);
  return requireTask(task.id);
}

/**
 * Feeds the next waiting follow-up back into the session a run just finished
 * in. Only a clean landing advances the queue: a run that failed, blocked, or
 * stopped to ask something leaves its items in place, so a hold that later
 * revives the task picks the queue back up, and nothing is ever sent into a
 * session that is already in trouble.
 */
export async function feedFollowUpQueue(task: Task): Promise<void> {
  const store = stateStore();
  if (task.state === "cancelled") {
    store.clearFollowUps(task.id, task.state, "the task was cancelled");
    return;
  }
  if (task.state !== "completed") {
    const waiting = store.countFollowUps(task.id);
    if (waiting > 0) appendTaskEvent(task.id, "follow_ups_paused", task.state, { waiting });
    return;
  }
  const instruction = store.takeNextFollowUp(task.id);
  if (!instruction) return;
  appendTaskEvent(task.id, "follow_up_started", task.state, {
    instruction,
    waiting: store.countFollowUps(task.id),
  });
  try {
    await resumeTask(task.id, instruction);
  } catch (error) {
    // The item is already claimed, so it rides the event rather than vanishing:
    // whoever queued it can read what was meant to run and send it again.
    appendTaskEvent(task.id, "follow_ups_paused", task.state, {
      instruction,
      waiting: store.countFollowUps(task.id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Parks a resume behind a hold instead of running it. `"rate_limit"` reads the
 * failed run's own `resetsAt` and keys the release on the account's status —
 * the reset time is only the poll hint, and the sweep will not release into an
 * account still reporting `unavailable`.
 */
function armResumeHold(old: Task, instruction: string | undefined, startAt: string): Task {
  const now = new Date();
  const rateLimit = startAt === "rate_limit";
  const until = rateLimit
    ? old.completion?.resetsAt ?? new Date(now.getTime() + 10 * 60_000).toISOString()
    : resolveStartAt(startAt, now);
  const note = rateLimit
    ? `waiting for ${old.profileId}/${old.model} to have usage again; not before ${until}`
    : `scheduled to continue at ${until}`;
  const task = stateStore().armTaskHold({
    taskId: old.id,
    verb: "resume",
    args: instruction ? { instruction } : {},
    startAt: until,
    ...(rateLimit ? { awaitProfile: old.profileId, awaitModel: old.model } : {}),
    nextCheckAt: until,
    expiresAt: new Date(now.getTime() + HOLD_EXPIRY_MS).toISOString(),
    probeCount: 0,
    note,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  taskWaiter.notify(old.id);
  return task;
}

/**
 * Continue a dead task on a different provider account.
 *
 * `resume` reopens the provider session, and a session belongs to one account:
 * when the account is what failed, that session is unreachable and every turn
 * it spent is stranded. Everything else about the run is Inter's own — the
 * prompt, the attempts, the event trace — so a handoff rebuilds a brief from
 * those rows and starts a fresh session with it. Same task id, same lineage,
 * same attempt history; new profile, new session, no hand-written prompt.
 */
export async function handoffTask(
  id: string,
  profileId: string,
  options: HandoffOptions = {},
): Promise<Task> {
  const old = requireContinuableTask(id, "handed off");
  if (profileId === old.profileId) {
    throw new Error(
      `handoff needs a different profile: task ${id} is already on ${profileId} — use resume to continue on the same account and provider session`,
    );
  }
  requireTaskWorktree(old);
  // The destination must be usable in the task's workspace, not just anywhere.
  const config = await loadConfig(projectCwd(old));
  const profile = config.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(unknownProfileMessage(profileId, config.profiles));
  if (!profile.enabled) throw new Error(`profile disabled: ${profileId}`);
  // The old model id names a model on the old account; carrying it across would
  // send a provider a name it has never heard of.
  const model = options.model?.trim() || profile.model;
  if (model.length > 200) throw new Error("model exceeds 200 characters");
  const effort = options.effort?.trim() || old.effort;
  // A stated scope is fresh approval for this destination and becomes its grant,
  // exactly as on delegate and resume. Anything else keeps the task's own scope:
  // a handoff must never widen what a task may touch on the way out.
  const replacement = options.scope ? resolveScope(projectCwd(old), profileId, options.scope) : undefined;
  const approvedHere = stateStore().latestScopeGrant(projectCwd(old), profileId)?.profileId === profileId;
  // Built before the row moves: `old` still names the profile whose work this
  // is, and still carries the failure the brief has to explain.
  const brief = handoffBrief(
    old,
    stateStore().listTaskEvents(id),
    config.profiles.find(({ id: item }) => item === old.profileId)?.provider ?? profile.provider,
  );
  const task = stateStore().handoffTask(id, {
    profileId,
    model,
    ...(effort ? { effort } : {}),
    ...(replacement ? { scope: replacement.scope } : {}),
    ...(replacement?.grantId ? { grantId: replacement.grantId } : {}),
  });
  // Same warning path as delegate: approval names a destination, and this task's
  // scope was approved for the profile it is leaving.
  if (!replacement && !approvedHere) {
    appendTaskEvent(task.id, "scope_inherited", task.state, {
      scope: task.scope,
      approvedFor: old.profileId,
      usedBy: profileId,
      reason: `scope was approved for profile ${old.profileId}, not ${profileId}`,
    });
  }
  appendTaskEvent(task.id, "handoff_brief", task.state, {
    tier: brief.tier,
    chars: brief.chars,
    ...(brief.omittedMessages ? { omittedMessages: brief.omittedMessages } : {}),
  });
  taskWaiter.notify(id);
  launchTask(task, profile, undefined, brief.prompt);
  return task;
}

function validateTimeoutMs(timeoutMs?: number): void {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)) {
    throw new Error("timeoutMs must be an integer between 1 and 86400000");
  }
}

function sessionResumeUnsupported(profileId: string, profile?: Profile): string {
  return profile?.command
    ? `profile ${profileId} runs a custom command; provider sessions are never captured, so reply/resume is unavailable`
    : `task profile cannot resume sessions: ${profileId}`;
}

export async function cancelTask(id: string, reason = "cancelled by caller", timedOut = false): Promise<Task> {
  const task = requireTask(id);
  if (task.state === "cancelled") return task;
  const completion = {
    blocked: true,
    code: timedOut ? "timeout" as const : "cancelled" as const,
    reason,
  };
  const cancelled = stateStore().cancelTask(id, reason, completion);
  if (!cancelled) {
    const current = stateStore().getTask(id);
    if (current?.state === "cancelled") return current;
    throw new Error(`task cannot be cancelled from state ${current?.state ?? task.state}: ${id}`);
  }
  const active = activeWorkers.get(id);
  if (active) {
    active.cancelled = true;
    active.task.state = cancelled.state;
    if (timedOut) {
      stopWorker(active);
    } else {
      killProcessGroup(active.child, "SIGTERM");
      active.forceKill = setTimeout(() => killProcessGroup(active.child, "SIGKILL"), FORCE_KILL_GRACE_MS);
    }
  }
  taskWaiter.notify(id);
  foldContext(cancelled);
  return cancelled;
}

/**
 * The states a caller can assert completion over: the run is dead and the
 * worker never attested its own success, so a human check can resolve the
 * record. `cancelled` is deliberately absent — the caller already corrected
 * that record by cancelling it, and resume or archive are its paths — and
 * `running` is a worse mistake than a wrong record.
 */
const ASSERTABLE_STATES: Task["state"][] = ["blocked", "failed"];

/**
 * States a caller can force-settle from the app: the run is stuck and will not
 * end on its own, so a human gives up waiting on it. The task moves to
 * `completed` and any live worker is stopped first, exactly like cancel, so
 * nothing keeps writing to a settled row. A `failed` or `cancelled` run has no
 * worker left to stop — it settled without resolving, so marking it completed
 * clears it out of the attention-ranked list. Only `completed` is absent, where
 * the action is a no-op. `answered` is unreachable as a stored state but the
 * enum keeps it, so the guard lists it for symmetry.
 */
const FORCE_COMPLETABLE_STATES: Task["state"][] = [
  "queued", "running", "needs_input", "answered", "blocked", "failed", "cancelled",
];

/**
 * Mark a blocked or failed task completed on the caller's word that the work
 * landed, keeping the unverified completion on the record. The distinction is
 * the point: `completion` still carries the worker's missing attestation, and
 * `completion.assertedCompletion` carries who asserted, why, and the code it
 * replaced, so a reader can tell an asserted completion from a verified one
 * without opening the database.
 */
export async function assertTaskCompletion(id: string, assertedBy: string, reason: string): Promise<Task> {
  const by = assertedBy.trim();
  if (!by) throw new Error(`asserted completion needs who asserted it: ${id}`);
  if (by.length > 200) throw new Error("assertedBy exceeds 200 characters");
  const why = reason.trim();
  if (!why) throw new Error(`asserted completion needs a reason: ${id}`);
  if (why.length > 500) throw new Error("reason exceeds 500 characters");
  const task = requireTask(id);
  if (task.state === "completed") {
    throw new Error(`task is already completed: ${id}`);
  }
  if (task.state === "running") {
    throw new Error(`task is still running: ${id} — asserting completion of work still in flight is not allowed; wait for it to settle`);
  }
  if (task.state === "cancelled") {
    throw new Error(`task was cancelled: ${id} — the cancellation is the caller's own record; resume it or archive it instead`);
  }
  if (!ASSERTABLE_STATES.includes(task.state)) {
    throw new Error(`task cannot be asserted completed from state ${task.state}: ${id} — completion is asserted only over a dead run the worker did not attest (blocked or failed)`);
  }
  const completed = stateStore().assertTaskCompletion(id, { assertedBy: by, reason: why });
  taskWaiter.notify(id);
  foldContext(completed);
  return completed;
}

/**
 * Force-settles a task the caller has given up waiting on. The state moves to
 * `completed` and the record carries who asserted it and why; a worker still
 * running is stopped the way cancel stops one, so it cannot keep writing to a
 * settled row. A `failed` or `cancelled` run has no worker left to stop, so
 * only the record moves. Already-completed is a no-op; every other state is a
 * refusal.
 */
export async function markTaskCompleted(id: string, assertedBy: string, reason: string): Promise<Task> {
  const by = assertedBy.trim();
  if (!by) throw new Error(`marking a task completed needs who asserted it: ${id}`);
  if (by.length > 200) throw new Error("assertedBy exceeds 200 characters");
  const why = reason.trim();
  if (!why) throw new Error(`marking a task completed needs a reason: ${id}`);
  if (why.length > 500) throw new Error("reason exceeds 500 characters");
  const task = requireTask(id);
  if (task.state === "completed") return task;
  if (!FORCE_COMPLETABLE_STATES.includes(task.state)) {
    throw new Error(`task cannot be marked completed from state ${task.state}: ${id}`);
  }
  const completed = stateStore().forceCompleteTask(id, { assertedBy: by, reason: why });
  const active = activeWorkers.get(id);
  if (active) {
    active.cancelled = true;
    active.task.state = completed.state;
    killProcessGroup(active.child, "SIGTERM");
    active.forceKill = setTimeout(() => killProcessGroup(active.child, "SIGKILL"), FORCE_KILL_GRACE_MS);
  }
  taskWaiter.notify(id);
  foldContext(completed);
  return completed;
}

function update(task: Task, patch: Partial<Task>, expectedStates: Task["state"][] = []): boolean {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  const eventType = task.state === "running" ? "started"
    : task.state === "needs_input" ? "needs_input"
    : task.state === "answered" ? "answered"
    : task.state === "blocked" ? "blocked"
    : task.state === "completed" ? "completed"
    : task.state === "failed" ? "failed"
    : task.state === "cancelled" ? "cancelled"
    : "state_changed";
  const saved = stateStore().saveTask(task, eventType, {
    ...(task.error ? { error: task.error } : {}),
    ...(task.question ? { question: task.question } : {}),
    ...(task.completion ? { completion: task.completion } : {}),
  }, expectedStates);
  if (!saved) {
    const current = stateStore().getTask(task.id);
    if (current) Object.assign(task, current);
    return false;
  }
  if (
    task.state === "needs_input" || task.state === "blocked" ||
    task.state === "completed" || task.state === "failed" || task.state === "cancelled"
  ) {
    taskWaiter.notify(task.id);
  }
  // Every settle funnels through here — run, fail, cancel, question — and a
  // settled task may have written files, so its writes fold into the map. The
  // fold is queued, never awaited: it is housekeeping, not part of the settle.
  if (patch.state && settled(patch.state)) {
    foldContext(task);
    // Same rule for the follow-up queue: the settle is what decides whether the
    // next instruction goes in, and it must not wait on the run that follows. A
    // copy, because a fed follow-up moves the live row out of the state that
    // decided it.
    void feedFollowUpQueue({ ...task });
  }
  return true;
}

function killProcessGroup(child: WorkerProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * The graceful stop: SIGINT so the provider CLI can flush its session, SIGTERM
 * if it ignores that, SIGKILL if it ignores that. The pending timer always
 * lives in `forceKill`, so the run's finally can cancel the ladder the moment
 * the child is gone.
 */
function stopWorker(active: ActiveWorker): void {
  killProcessGroup(active.child, "SIGINT");
  active.forceKill = setTimeout(() => {
    killProcessGroup(active.child, "SIGTERM");
    active.forceKill = setTimeout(
      () => killProcessGroup(active.child, "SIGKILL"),
      SHUTDOWN_TERM_GRACE_MS,
    );
  }, SHUTDOWN_INT_GRACE_MS);
}
