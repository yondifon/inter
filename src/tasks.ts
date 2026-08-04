import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { canResumeSession, commandFor, finalText, resumeCommandFor, sessionIdFrom, writeTargetsFrom } from "./adapters";
import { loadConfig, profileEnv } from "./config";
import { taskEventView } from "./events";
import {
  continuationPrompt,
  interpretWorkerOutcome,
  needsInputQuestion,
  rateLimitResetAt,
  workerPrompt,
} from "./task-protocol";
import { handoffBrief } from "./handoff-brief";
import { normalizeTaskScope, sandboxedCommand, scopeCoversPath, scopeRefusedWrite } from "./task-scope";
import { workerPath } from "./worker-path";
import { deniedScopePaths, promptReadPaths } from "./prompt-paths";
import { stateStore, type StateStore, type TaskListQuery } from "./store";
import { promptWithMemories } from "./memories";
import { TaskWaiter, type TaskWaitResult, type WaitUntil } from "./task-waiter";
import type { Profile, Task, TaskScope, TaskSummary } from "./types";

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
  /** Caller's one-line handle for the task, what a human reads instead of the prompt. */
  tldr?: string;
  /** Short label for the task, what a sidebar reads at a glance. */
  title?: string;
}

export interface ResumeOptions {
  scope?: TaskScope;
  allowQuestions?: boolean;
  timeoutMs?: number;
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
 * value may stand in for the run's.
 */
export function accumulateRunCost(
  current: { costUsd?: number; turns?: number },
  payload: Record<string, unknown>,
): { costUsd?: number; turns?: number } {
  const reported = runCostFrom(payload);
  if (reported.costUsd !== undefined || reported.turns !== undefined) return reported;
  const share = piMessageCostFrom(payload);
  return share === undefined ? current : { ...current, costUsd: (current.costUsd ?? 0) + share };
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

function numberOr(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
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

export function getTask(id: string): Task | undefined {
  return stateStore().getTask(id);
}

export async function waitForTasks(
  taskIds: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  afterCursor?: number,
  until?: WaitUntil,
): Promise<TaskWaitResult> {
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
      summary: view
        ? `${view.title}${view.detail ? `: ${view.detail}` : ""}`.slice(0, 500)
        : event.type,
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
}

/// pi streams one message_update per token — 4,365 thinking_delta rows in a
/// measured 63 s — which would burn the 5,000-event cap in about a minute.
/// The deltas of one block are folded into a buffer and stored once at the
/// block boundary, in the `*_end` shape pi itself uses to close with the whole
/// block in `content`; a block that never ends still surfaces a row each
/// PI_DELTA_FLUSH_MS. toolcall_* fragments are dropped outright:
/// tool_execution_* already records the call, and a streamed argument token
/// is not row-worthy. The fold keys off the pi provider, never off the shape —
/// a non-pi provider emitting identical lines stores them verbatim.
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
    const next = block?.kind === kind ? block : { kind, text: "" };
    const text = typeof detail.delta === "string" ? detail.delta : "";
    next.text += text;
    if (now - lastFlushAt >= PI_DELTA_FLUSH_MS) {
      return {
        block: next,
        row: { type: "message_update", assistantMessageEvent: { type: `${kind}_end`, content: next.text } },
      };
    }
    return { block: next };
  }
  if (type === "thinking_start" || type === "text_start") {
    return { block: { kind, text: typeof detail.delta === "string" ? detail.delta : "" } };
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
  stateStore().createTask(task);
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
  const config = await loadConfig();
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
  const task: Task = {
    id: crypto.randomUUID(),
    profileId,
    model,
    prompt,
    cwd: workspace,
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
  try {
    scratchDir = mkdtempSync(resolve(tmpdir(), "inter-worker-"));
    const hookUrl = `${Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`}/api/hooks/${task.id}`;
    const sharedPrompt = promptWithMemories(
      promptOverride ?? task.prompt,
      stateStore().listMemories(task.cwd),
    );
    const prompt = workerPrompt(sharedPrompt, task.allowQuestions, task.scope);
    // The caller's prompt is only part of what leaves the machine; store the
    // real text so "what was sent to this provider" is answerable later.
    stateStore().recordShippedPrompt(task.id, prompt);
    task.shippedPrompt = prompt;
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
      const child = Bun.spawn(sandboxedCommand(command, task.cwd, task.scope, profile, scratchDir), {
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
      appendTaskEvent(task.id, "worker_spawned", task.state, {
        provider: profile.provider,
        model: task.model,
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
          // One oversized payload — a large file read echoed back as a tool
          // result — must cost only that line, not the rest of the trace.
          if (line.length > MAX_EVENT_LINE) {
            if (!oversizedLine) {
              oversizedLine = true;
              appendTaskEvent(task.id, "event_dropped", task.state, {
                bytes: line.length,
                limit: MAX_EVENT_LINE,
              });
              eventCount++;
            }
            return;
          }
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
          // pi — as one `usage.cost.total` per `message_end`, which adds to it.
          runCost = accumulateRunCost(runCost, payload);
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
      // Never turn a failed resume into a fresh session. A fresh worker would
      // receive the answer but lose the provider's accumulated context.
      if (
        resumeWith && exitCode !== 0 && attemptEvents === 0 &&
        !active.cancelled && stateStore().getTask(task.id)?.state !== "cancelled"
      ) {
        appendTaskEvent(task.id, "resume_failed", task.state, {
          resumedSession: resumeWith,
          exitCode,
          error: stderr.trim().slice(0, 500),
        });
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
    const outcome = interpretWorkerOutcome(exitCode, output, stderr);
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
      completion: withScopeSuggestion(task, outcome.completion),
    }, ["running"]);
    if (!persisted) return;
    recordProfileTaskOutcome(stateStore(), task.profileId, outcome);
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
    stateStore().recordTaskCost(task.id, runCost.costUsd, runCost.turns);
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

export function recordProfileTaskOutcome(
  store: Pick<StateStore, "clearProfileFailure" | "recordProfileFailure">,
  profileId: string,
  outcome: ReturnType<typeof interpretWorkerOutcome>,
): void {
  if (outcome.state === "completed") {
    store.clearProfileFailure(profileId);
    return;
  }
  if (outcome.state !== "failed") return;
  const { code } = outcome.completion;
  if (code !== "auth" && code !== "billing" && code !== "rate_limit") return;
  store.recordProfileFailure(
    profileId,
    code,
    outcome.completion.reason ?? outcome.error ?? "provider failure",
    // The provider said when it will answer again; the ten-minute guess this
    // otherwise falls back to is what made a five-hour window look retryable.
    outcome.completion.resetsAt,
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
const RESUMABLE_STATES: Task["state"][] = ["failed", "cancelled", "blocked"];

function requireTask(id: string): Task {
  const task = stateStore().getTask(id);
  if (!task) throw new Error(unknownTaskMessage(id));
  return task;
}

/**
 * A task that exists and is in a state a continuation verb can act on. `verb`
 * names the operation in the refusal, which is the only thing `resume` and
 * `handoff` legitimately differ on here.
 */
function requireContinuableTask(id: string, verb: "resumed" | "handed off"): Task {
  const task = requireTask(id);
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
  const profile = (await loadConfig()).profiles.find((item) => item.id === task.profileId);
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
  const profile = await requireSessionProfile(old, "reply to");
  const prompt = continuationPrompt(
    old.prompt,
    old.question ?? "What input is required?",
    answer,
  );
  // A replacement scope is a fresh statement of what this cwd may touch, so it
  // becomes the grant later delegations inherit.
  const replacement = options.scope ? resolveScope(old.cwd, old.profileId, options.scope) : undefined;
  const task = stateStore().answerTask(id, {
    answer,
    ...(replacement ? { scope: replacement.scope } : {}),
    ...(replacement?.grantId ? { grantId: replacement.grantId } : {}),
  });
  taskWaiter.notify(id);
  launchTask(task, profile, old.sessionId, prompt);
  return task;
}

export async function resumeTask(
  id: string,
  instruction?: string,
  options: ResumeOptions = {},
): Promise<Task> {
  const old = requireContinuableTask(id, "resumed");
  const profile = await requireSessionProfile(
    old,
    "resume",
    " — the worker exited before the provider created a session; delegate a fresh task instead",
  );
  validateTimeoutMs(options.timeoutMs);
  // A replacement scope is a fresh statement of what this cwd may touch, so it
  // becomes the grant later delegations inherit.
  const replacement = options.scope ? resolveScope(old.cwd, old.profileId, options.scope) : undefined;
  const resumeInstruction = instruction?.trim() || "Continue the original task from where the previous run stopped.";
  const prompt = [
    "# Resume instruction",
    resumeInstruction,
    "",
    `The previous Inter run ended in state \`${old.state}\`. Continue the existing provider session without repeating completed work.`,
  ].join("\n");
  const task = stateStore().resumeTask(id, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(replacement ? { scope: replacement.scope } : {}),
    ...(replacement?.grantId ? { grantId: replacement.grantId } : {}),
    ...(options.allowQuestions !== undefined ? { allowQuestions: options.allowQuestions } : {}),
  });
  taskWaiter.notify(id);
  launchTask(task, profile, old.sessionId, prompt);
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
  const config = await loadConfig();
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
  const replacement = options.scope ? resolveScope(old.cwd, profileId, options.scope) : undefined;
  const approvedHere = stateStore().latestScopeGrant(old.cwd, profileId)?.profileId === profileId;
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
    killProcessGroup(active.child, "SIGTERM");
    active.forceKill = setTimeout(() => killProcessGroup(active.child, "SIGKILL"), 2_000);
  }
  taskWaiter.notify(id);
  return cancelled;
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
