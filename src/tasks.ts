import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { canResumeSession, commandFor, finalText, resumeCommandFor, sessionIdFrom, writeTargetsFrom } from "./adapters";
import { loadConfig, profileEnv } from "./config";
import { taskEventView } from "./events";
import { continuationPrompt, interpretWorkerOutcome, needsInputQuestion, workerPrompt } from "./task-protocol";
import { normalizeTaskScope, sandboxedCommand, scopeRefusedWrite } from "./task-scope";
import { stateStore, type StateStore, type TaskListQuery } from "./store";
import { promptWithMemories } from "./memories";
import { TaskWaiter, type TaskWaitResult, type WaitUntil } from "./task-waiter";
import type { Profile, Task, TaskScope, TaskSummary } from "./types";

const MAX_EVENT_LINE = 64 * 1024;
const MAX_EVENTS = 5_000;
const MAX_OUTPUT = 10 * 1024 * 1024;
const MAX_ANTIGRAVITY_BOOTSTRAP_RETRIES = 2;
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
    id: crypto.randomUUID(),
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
  try {
    scratchDir = mkdtempSync(resolve(tmpdir(), "inter-worker-"));
    const hookUrl = `${Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`}/api/hooks/${task.id}`;
    const sharedPrompt = promptWithMemories(
      promptOverride ?? task.prompt,
      stateStore().listMemories(task.cwd),
    );
    const prompt = workerPrompt(sharedPrompt, task.allowQuestions, task.scope);
    const env = {
      ...Bun.env,
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
    let lastAgentEventAt = startedAt;
    let eventCount = 0;
    let eventCaptureStopped = false;
    let oversizedLine = false;
    const flaggedWrites = new Set<string>();
    let resumeWith = resumeSessionId;
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let bootstrapRetries = 0;
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
              const store = stateStore();
              if (!task.sessionId) {
                if (store.captureTaskSessionId(task.id, profile.provider, sessionId)) {
                  task.sessionId = sessionId;
                  taskWaiter.notify(task.id);
                } else {
                  task.sessionId = store.getTask(task.id)?.sessionId;
                }
              } else if (
                sessionId !== task.sessionId &&
                store.replaceTaskSessionId(task.id, profile.provider, task.sessionId, sessionId)
              ) {
                task.sessionId = sessionId;
                taskWaiter.notify(task.id);
              }
            }
          } catch {}
        }),
        readStream(child.stderr, undefined, MAX_EVENT_LINE),
        child.exited,
      ]);
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

function lastWorkerErrorDetail(
  taskId: string,
  provider: Profile["provider"],
): { error?: string; last?: string } {
  const events = stateStore().listTaskEvents(taskId);
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
  if (old.state !== "needs_input") {
    throw new Error(old.state === "blocked"
      ? `task does not need input: ${id} — state is blocked; use resume with your answer as the instruction`
      : `task does not need input: ${id} (state: ${old.state})`);
  }
  const config = await loadConfig();
  const profile = config.profiles.find((item) => item.id === old.profileId);
  if (!profile || !canResumeSession(profile)) {
    throw new Error(sessionResumeUnsupported(old.profileId, profile));
  }
  if (!old.sessionId) throw new Error(`task has no captured session to reply to: ${id}`);
  const prompt = continuationPrompt(
    old.prompt,
    old.question ?? "What input is required?",
    answer,
  );
  const task = stateStore().answerTask(id);
  taskWaiter.notify(id);
  launchTask(task, profile, old.sessionId, prompt);
  return task;
}

export async function resumeTask(id: string, instruction?: string, timeoutMs?: number): Promise<Task> {
  const old = stateStore().getTask(id);
  if (!old) throw new Error(`unknown task: ${id}`);
  if (!["failed", "cancelled", "blocked"].includes(old.state)) {
    throw new Error(`task cannot be resumed from state ${old.state}: ${id}`);
  }
  // Check the structural limitation before the missing session id: a profile
  // that can never capture a session would otherwise surface the misleading
  // "no captured session" message.
  const config = await loadConfig();
  const profile = config.profiles.find((item) => item.id === old.profileId);
  if (!profile || !canResumeSession(profile)) {
    throw new Error(sessionResumeUnsupported(old.profileId, profile));
  }
  if (!old.sessionId) {
    throw new Error(
      `task has no captured session to resume: ${id} — the worker exited before the provider created a session; delegate a fresh task instead`,
    );
  }
  const resumeInstruction = instruction?.trim() || "Continue the original task from where the previous run stopped.";
  const { task } = await prepareTask(
    old.profileId,
    [
      "# Original task",
      old.prompt,
      "",
      "# Resume instruction",
      resumeInstruction,
      "",
      `The previous run ended in state \`${old.state}\`. Do not repeat completed work.`,
    ].join("\n"),
    old.cwd,
    old.model,
    old.id,
    {
      scope: old.scope,
      allowQuestions: old.allowQuestions,
      ...(timeoutMs !== undefined
        ? { timeoutMs }
        : old.timeoutMs ? { timeoutMs: old.timeoutMs } : {}),
    },
  );
  stateStore().createResumption(old.id, task);
  taskWaiter.notify(old.id);
  launchTask(task, profile, old.sessionId);
  return task;
}

function sessionResumeUnsupported(profileId: string, profile?: Profile): string {
  return profile?.command
    ? `profile ${profileId} runs a custom command; provider sessions are never captured, so reply/resume is unavailable`
    : `task profile cannot resume sessions: ${profileId}`;
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
