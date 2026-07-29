import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { commandFor, finalText } from "./adapters";
import { loadConfig, profileEnv } from "./config";
import { stateStore } from "./store";
import { TaskWaiter, type TaskWaitResult } from "./task-waiter";
import type { Task } from "./types";

const NEEDS_INPUT = /(?:^|\r?\n)[\t ]*(?:INTER_NEEDS_INPUT|NEEDS_INPUT)\s*:\s*(.+)/i;
const MAX_EVENT_LINE = 64 * 1024;
const MAX_EVENTS = 5_000;
const MAX_OUTPUT = 10 * 1024 * 1024;
const taskWaiter = new TaskWaiter(
  (id) => stateStore().getTask(id),
  (ids) => stateStore().latestTaskEventId(ids),
);

export function listTasks(): Task[] {
  return stateStore().listTasks();
}

export function getTask(id: string): Task | undefined {
  return stateStore().getTask(id);
}

export function waitForTasks(
  taskIds: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  afterCursor?: number,
): Promise<TaskWaitResult> {
  return taskWaiter.wait(taskIds, timeoutMs, signal, afterCursor);
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

export function needsInputQuestion(output: string): string | undefined {
  return output.match(NEEDS_INPUT)?.[1]?.trim() || undefined;
}

export async function delegate(
  profileId: string,
  prompt: string,
  cwd: string,
  requestedModel?: string,
  parentTaskId?: string,
): Promise<Task> {
  const workspace = await validateWorkspace(cwd);
  const config = await loadConfig();
  const profile = config.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown profile: ${profileId}`);
  if (!profile.enabled) throw new Error(`profile disabled: ${profileId}`);
  const model = requestedModel?.trim() || profile.model;
  if (model.length > 200) throw new Error("model exceeds 200 characters");

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
    ...(parentTaskId ? { parentTaskId } : {}),
  };
  stateStore().createTask(task);
  void runTask(task, profile);
  return task;
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

async function runTask(task: Task, profile: Awaited<ReturnType<typeof loadConfig>>["profiles"][number]): Promise<void> {
  update(task, { state: "running" });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const hookUrl = `${Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`}/api/hooks/${task.id}`;
    const child = Bun.spawn(commandFor(profile, task.prompt, task.cwd, task.model, hookUrl), {
      cwd: task.cwd,
      env: {
        ...Bun.env,
        ...profileEnv(profile),
        INTER_TASK_ID: task.id,
        INTER_HOOK_URL: hookUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    appendTaskEvent(task.id, "worker_spawned", task.state, {
      provider: profile.provider,
      model: task.model,
    });
    const startedAt = Date.now();
    let lastAgentEventAt = startedAt;
    heartbeat = setInterval(() => {
      const silentMs = Date.now() - lastAgentEventAt;
      appendTaskEvent(task.id, "heartbeat", task.state, {
        elapsedMs: Date.now() - startedAt,
        silentMs,
        stalled: silentMs >= 30_000,
      });
    }, 10_000);
    let eventCount = 0;
    let eventCaptureStopped = false;
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout, (line) => {
        if (eventCaptureStopped) return;
        if (eventCount >= MAX_EVENTS || line.length > MAX_EVENT_LINE) {
          if (!eventCaptureStopped) {
            appendTaskEvent(task.id, "events_truncated", task.state, {});
            eventCaptureStopped = true;
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
        } catch {}
      }),
      readStream(child.stderr, undefined, MAX_EVENT_LINE),
      child.exited,
    ]);
    const output = finalText(profile, stdout);
    const question = needsInputQuestion(output);
    if (question) update(task, { state: "needs_input", output, question });
    else if (exitCode === 0) update(task, { state: "completed", output });
    else update(task, { state: "failed", output, error: stderr.trim() || `exit ${exitCode}` });
  } catch (error) {
    update(task, { state: "failed", error: String(error) });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
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
  return delegate(
    old.profileId,
    `${old.prompt}\n\nEarlier worker question: ${old.question}\nParent answer: ${answer}\nContinue the task.`,
    old.cwd,
    old.model,
    old.id,
  );
}

function update(task: Task, patch: Partial<Task>): void {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  const eventType = task.state === "running" ? "started"
    : task.state === "needs_input" ? "needs_input"
    : task.state === "completed" ? "completed"
    : task.state === "failed" ? "failed"
    : "state_changed";
  stateStore().saveTask(task, eventType, {
    ...(task.error ? { error: task.error } : {}),
    ...(task.question ? { question: task.question } : {}),
  });
  if (task.state === "needs_input" || task.state === "completed" || task.state === "failed") {
    taskWaiter.notify(task.id);
  }
}
