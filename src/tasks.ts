import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { canResumeSession, commandFor, finalText, resumeCommandFor, sessionIdFrom } from "./adapters";
import { loadConfig, profileEnv } from "./config";
import { taskEventView } from "./events";
import { continuationPrompt, interpretWorkerOutcome, needsInputQuestion, workerPrompt } from "./task-protocol";
import { normalizeTaskScope, sandboxedCommand } from "./task-scope";
import { stateStore, type StateStore, type TaskListQuery } from "./store";
import { TaskWaiter, type TaskWaitResult } from "./task-waiter";
import type { Profile, Task, TaskScope, TaskSummary } from "./types";

const MAX_EVENT_LINE = 64 * 1024;
const MAX_EVENTS = 5_000;
const MAX_OUTPUT = 10 * 1024 * 1024;
const taskWaiter = new TaskWaiter(
  (id) => stateStore().getTask(id),
  (ids) => stateStore().latestTaskEventId(ids, true),
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
}

export function listTasks(): Task[] {
  return stateStore().listTasks();
}

export function listTaskSummaries(query: TaskListQuery = {}): TaskSummary[] {
  return stateStore().listTaskSummaries(query);
}

export function getTask(id: string): Task | undefined {
  return stateStore().getTask(id);
}

export async function waitForTasks(
  taskIds: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  afterCursor?: number,
): Promise<TaskWaitResult> {
  const waited = await taskWaiter.wait(taskIds, timeoutMs, signal, afterCursor);
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
  const { task, profile } = await prepareTask(
    profileId,
    prompt,
    cwd,
    requestedModel,
    parentTaskId,
    options,
  );
  stateStore().createTask(task);
  launchTask(task, profile);
  return task;
}

async function prepareTask(
  profileId: string,
  prompt: string,
  cwd: string,
  requestedModel?: string,
  parentTaskId?: string,
  options: DelegateOptions = {},
): Promise<{ task: Task; profile: Profile }> {
  const workspace = await validateWorkspace(cwd);
  const config = await loadConfig();
  const profile = config.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown profile: ${profileId}`);
  if (!profile.enabled) throw new Error(`profile disabled: ${profileId}`);
  const model = requestedModel?.trim() || profile.model;
  if (model.length > 200) throw new Error("model exceeds 200 characters");
  // parent_task_id is a foreign key, so an unknown id would otherwise surface as a
  // raw SQLite constraint failure after the caller already committed to the work.
  if (parentTaskId && !stateStore().getTask(parentTaskId)) {
    throw new Error(`unknown parent task: ${parentTaskId}`);
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)) {
    throw new Error("timeoutMs must be an integer between 1 and 86400000");
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    profileId,
    model,
    prompt,
    cwd: workspace,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: normalizeTaskScope(options.scope, workspace),
    allowQuestions: options.allowQuestions !== false,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  return { task, profile };
}

async function validateWorkspace(cwd: string): Promise<string> {
  const workspace = resolve(cwd);
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const roots = (process.env.INTER_ROOTS ?? process.cwd())
    .split(":")
    .filter(Boolean)
    .map((root) => resolve(root));
  if (!roots.some((root) => {
    const child = relative(root, workspace);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  })) throw new Error("cwd is outside INTER_ROOTS");
  if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) throw new Error("cwd does not exist");
  return workspace;
}

function launchTask(task: Task, profile: Profile, resumeSessionId?: string): void {
  void runTask(task, profile, resumeSessionId);
}

async function runTask(task: Task, profile: Profile, resumeSessionId?: string): Promise<void> {
  if (!update(task, { state: "running" }, ["queued"])) return;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let active: ActiveWorker | undefined;
  let scratchDir: string | undefined;
  try {
    scratchDir = mkdtempSync(resolve(tmpdir(), "inter-worker-"));
    const hookUrl = `${Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`}/api/hooks/${task.id}`;
    const prompt = workerPrompt(task.prompt, task.allowQuestions);
    const env = {
      ...Bun.env,
      ...profileEnv(profile),
      TMPDIR: scratchDir,
      INTER_TASK_ID: task.id,
      INTER_HOOK_URL: hookUrl,
    };
    const startedAt = Date.now();
    let lastAgentEventAt = startedAt;
    let eventCount = 0;
    let eventCaptureStopped = false;
    let oversizedLine = false;
    let resumeWith = resumeSessionId;
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    while (true) {
      const command = resumeWith
        ? resumeCommandFor(profile, prompt, task.cwd, resumeWith, task.model, hookUrl)
        : commandFor(profile, prompt, task.cwd, task.model, hookUrl);
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
          const silentMs = Date.now() - lastAgentEventAt;
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
      [stdout, stderr, exitCode] = await Promise.all([
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
            lastAgentEventAt = Date.now();
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
          try {
            const parsed = JSON.parse(line) as unknown;
            const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { value: parsed };
            const kind = typeof payload.type === "string" ? payload.type : "event";
            appendTaskEvent(task.id, `agent.${kind}`, task.state, payload);
            lastAgentEventAt = Date.now();
            eventCount++;
            attemptEvents++;
            if (!task.sessionId) {
              const sessionId = sessionIdFrom(profile.provider, payload);
              if (sessionId) {
                const store = stateStore();
                if (store.captureTaskSessionId(task.id, profile.provider, sessionId)) {
                  task.sessionId = sessionId;
                  taskWaiter.notify(task.id);
                } else {
                  task.sessionId = store.getTask(task.id)?.sessionId;
                }
              }
            }
          } catch {}
        }),
        readStream(child.stderr, undefined, MAX_EVENT_LINE),
        child.exited,
      ]);
      // A resume that dies before emitting a single agent event never reached the
      // model (e.g. the session file was pruned); retry once as a fresh run so the
      // caller's answer is not lost. Failures after events are real task failures.
      if (
        resumeWith && exitCode !== 0 && attemptEvents === 0 &&
        !active.cancelled && stateStore().getTask(task.id)?.state !== "cancelled"
      ) {
        appendTaskEvent(task.id, "resume_fallback", task.state, {
          resumedSession: resumeWith,
          exitCode,
          error: stderr.trim().slice(0, 500),
        });
        resumeWith = undefined;
        continue;
      }
      break;
    }
    if (active?.cancelled || stateStore().getTask(task.id)?.state === "cancelled") return;
    const output = finalText(profile, stdout);
    const outcome = interpretWorkerOutcome(exitCode, output, stderr);
    const persisted = update(task, {
      state: outcome.state,
      output: outcome.output,
      ...(outcome.question ? { question: outcome.question } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      completion: outcome.completion,
    }, ["running"]);
    if (!persisted) return;
    recordProfileTaskOutcome(stateStore(), task.profileId, outcome);
  } catch (error) {
    if (!active?.cancelled && stateStore().getTask(task.id)?.state !== "cancelled") {
      const message = String(error);
      update(task, {
        state: "failed",
        error: message,
        completion: { blocked: true, code: "worker_error", reason: message },
      }, ["running"]);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (active?.timeout) clearTimeout(active.timeout);
    if (active?.forceKill) clearTimeout(active.forceKill);
    activeWorkers.delete(task.id);
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
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
  );
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  outputLimit = MAX_OUTPUT,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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

export async function reply(id: string, answer: string): Promise<Task> {
  const old = stateStore().getTask(id);
  if (!old) throw new Error(`unknown task: ${id}`);
  if (old.state !== "needs_input") throw new Error(`task does not need input: ${id}`);
  const { task, profile } = await prepareTask(
    old.profileId,
    continuationPrompt(old.prompt, old.question ?? "What input is required?", answer),
    old.cwd,
    old.model,
    old.id,
    {
      scope: old.scope,
      allowQuestions: old.allowQuestions,
      ...(old.timeoutMs ? { timeoutMs: old.timeoutMs } : {}),
    },
  );
  stateStore().createContinuation(old.id, task);
  taskWaiter.notify(old.id);
  // Continue inside the worker's own CLI session when the provider supports it;
  // the continuation prompt stays self-sufficient so a fallback fresh run works.
  const resumeSessionId = old.sessionId && canResumeSession(profile) ? old.sessionId : undefined;
  launchTask(task, profile, resumeSessionId);
  return task;
}

export async function cancelTask(id: string, reason = "cancelled by caller", timedOut = false): Promise<Task> {
  const task = stateStore().getTask(id);
  if (!task) throw new Error(`unknown task: ${id}`);
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
    active.task.state = "cancelled";
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
    ...(task.childTaskId ? { childTaskId: task.childTaskId } : {}),
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
