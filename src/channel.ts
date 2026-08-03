#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

// The channel is a Claude Code-only accelerator on top of Inter's portable
// follow-along (a blocking `wait` call with until: "attention"), not a
// replacement for it. `notifications/claude/channel` is an Anthropic
// extension, so codex, opencode, antigravity, and pi cannot receive these
// events; those clients follow tasks with `wait`.
export const CHANNEL_INSTRUCTIONS = [
  "You receive delegated Inter task events as <channel source=\"inter\" ...> tags; a task reaching your attention here is also reachable any time with Inter's wait tool (until: \"attention\" works in every client). Handle by state:",
  "needs_input — the worker asked a question. Answer it directly with Inter's reply tool (task_id in the tag) when the answer is reversible and stays within the task's existing scope, or is a scope expansion you can already justify — reply accepts a scope granting paths with the answer. Do not bounce these to the user.",
  "completed — verify the result before treating the work as done.",
  "failed or blocked — read the reason in the tag, then decide whether to resume the task or re-delegate it.",
  "cancelled — the task was stopped. No further action needed unless you want to resume it.",
  "You can act on these yourself with the channel's cancel and resume tools: cancel stops a task you no longer want (even one parked on a question you will not answer), and resume retries a failed, cancelled, or blocked task, optionally with an instruction. No need to ask the user.",
  "Escalate to the user only for product intent, secrets, destructive actions, or authority the user has not already granted.",
].join(" ");

const brokerHost = `http://127.0.0.1:${Number(Bun.env.INTER_PORT ?? 7331)}`;
const brokerUrl = `${brokerHost}/api/state`;
const POLL_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_TRACKED_TASKS = 1_024;

// Polling `/api/state` on an interval rather than long-polling
// `/api/tasks/:id/events` per task: it gives a whole-broker view in one
// request, needs no prior knowledge of task ids, and survives broker
// restarts that a per-task cursor would miss.
export const WORTHY_STATES = new Set(["needs_input", "completed", "failed", "blocked", "cancelled"]);

// The fields of a task the watcher reads to build an event: a structural
// subset of Task (src/types.ts) so tests need not construct the whole row.
export interface TaskView {
  id: string;
  profileId: string;
  cwd: string;
  state: string;
  /** Short label for the task, what a sidebar reads at a glance. */
  title?: string;
  question?: string;
  error?: string;
  output?: string;
  completion?: { code?: string; reason?: string };
}

export interface ChannelEvent {
  method: "notifications/claude/channel";
  params: { content: string; meta: Record<string, string> };
}

// A task that settled before this session opened is history, not news, and
// `/api/state` returns every unarchived task — so a naive first poll greets
// the caller with every run they have not archived. `needs_input` is the
// exception: a worker still parked on a question is waiting on the caller
// right now, whenever it started waiting.
const ANNOUNCED_ON_FIRST_POLL = new Set(["needs_input"]);

/**
 * Snapshots the broker's task list and announces worthy states at most once
 * per (task, state). Snapshot polling can miss an intermediate transition,
 * so the invariant is not "catch every edge" but "announce each worthy state
 * exactly once", and never a state this watcher has already reported.
 */
export class ChannelWatcher {
  private announced = new Map<string, Set<string>>();
  private primed = false;

  constructor(private readonly maxTrackedTasks = DEFAULT_MAX_TRACKED_TASKS) {}

  /** Number of task ids with at least one announced state. */
  get size(): number {
    return this.announced.size;
  }

  apply(tasks: readonly TaskView[]): ChannelEvent[] {
    const events: ChannelEvent[] = [];
    for (const task of tasks) {
      if (!WORTHY_STATES.has(task.state)) continue;
      let states = this.announced.get(task.id);
      if (!states) {
        states = new Set();
        this.announced.set(task.id, states);
        // Map keeps insertion order, so the oldest task id is first. Evicting
        // it means a long-forgotten task may be announced again much later;
        // that is the price of the bound the set may not grow forever.
        while (this.announced.size > this.maxTrackedTasks) {
          const oldest = this.announced.keys().next().value;
          if (oldest === undefined) break;
          this.announced.delete(oldest);
        }
      }
      if (states.has(task.state)) continue;
      states.add(task.state);
      if (this.primed || ANNOUNCED_ON_FIRST_POLL.has(task.state)) events.push(channelEvent(task));
    }
    this.primed = true;
    return events;
  }
}

export function channelEvent(task: TaskView): ChannelEvent {
  return {
    method: "notifications/claude/channel",
    params: {
      content: eventContent(task),
      // meta keys become tag attributes and must be identifiers — letters,
      // digits, underscores only. Keys with hyphens are silently dropped.
      meta: {
        task_id: task.id,
        state: task.state,
        cwd: task.cwd,
        profile: task.profileId,
        ...(task.title ? { title: task.title } : {}),
      },
    },
  };
}

export function eventContent(task: TaskView): string {
  const { id, cwd, title } = task;
  // The title is the label a human scans for; lead with it and keep the id on
  // the same line so the message still reads when no title was given.
  const head = title ? `${title} (${id})` : `Inter task ${id}`;
  switch (task.state) {
    case "needs_input":
      return [
        `${head} needs your input.`,
        `question: ${task.question ?? "(no question recorded)"}`,
        `profile: ${task.profileId}`,
        `cwd: ${cwd}`,
        `Answer with Inter's reply tool (task_id: ${id}).`,
      ].join("\n");
    case "completed":
      return `${head} completed.\n${shortOutcome(task)}\ncwd: ${cwd}`;
    case "failed":
      return `${head} failed.\n${reasonLine(task)}\ncwd: ${cwd}`;
    case "blocked":
      return `${head} is blocked.\n${reasonLine(task)}\ncwd: ${cwd}`;
    case "cancelled":
      return `${head} was cancelled.\n${reasonLine(task)}\ncwd: ${cwd}`;
    default:
      return `${head} is ${task.state}.`;
  }
}

function shortOutcome(task: TaskView): string {
  const source = firstMeaningfulLine(task.output ?? "") ?? task.completion?.reason;
  return `outcome: ${collapse(source ?? "no output recorded", 200)}`;
}

function reasonLine(task: TaskView): string {
  const reason = task.completion?.reason ?? task.error ?? "no reason recorded";
  return `reason: ${collapse(reason, 500)}`;
}

function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function main(): Promise<void> {
  const mcp = new McpServer(
    { name: "inter-channel", version: "0.1.0" },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  const watcher = new ChannelWatcher();

  // Start watching only once the client has completed the handshake: events
  // pushed earlier are dropped, and the first poll then announces any task
  // already waiting on the caller when the session opened.
  mcp.server.oninitialized = () => {
    void pollLoop(mcp, watcher);
  };

  // Claude Code connected via the channel sees only the channel's tools, so
  // cancel/resume proxy to the broker's HTTP API rather than living broker-side.
  mcp.registerTool("cancel", {
    description: "Cancel a delegated Inter task via the broker. Works on queued, running, needs_input, and blocked tasks, so a task parked on a question you do not want to answer is not a dead end. This does not delete the task record.",
    inputSchema: z.object({
      taskId: z.string().describe("Inter task id returned by delegate, reply, or resume."),
      reason: z.string().min(1).max(500).optional()
        .describe("Stored as the task error and shown to the user. Default: \"cancelled by channel client\"."),
    }),
  }, async ({ taskId, reason }) => {
    const url = `${brokerHost}/api/tasks/${encodeURIComponent(taskId)}?reason=${encodeURIComponent(reason ?? "cancelled by channel client")}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) throw new Error(`cancel failed: DELETE /api/tasks/${taskId} -> ${response.status}${await errorDetail(response)}`);
    return result(await response.json());
  });
  mcp.registerTool("resume", {
    description: "Retry a failed, cancelled, or blocked Inter task via the broker, continuing its existing provider session. Optional instruction is given to the worker to continue; omit it to resume as-is.",
    inputSchema: z.object({
      taskId: z.string().describe("Inter task id returned by delegate, reply, or resume."),
      instruction: z.string().min(1).max(64_000).optional()
        .describe("Instruction for the worker continuing the session. Omit to resume as-is."),
    }),
  }, async ({ taskId, instruction }) => {
    const url = `${brokerHost}/api/tasks/${encodeURIComponent(taskId)}/resume`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: instruction === undefined ? undefined : JSON.stringify({ instruction }),
    });
    if (!response.ok) throw new Error(`resume failed: POST /api/tasks/${taskId}/resume -> ${response.status}${await errorDetail(response)}`);
    return result(await response.json());
  });

  await mcp.connect(new StdioServerTransport());
}

async function pollLoop(mcp: McpServer, watcher: ChannelWatcher): Promise<void> {
  let backoffMs = POLL_INTERVAL_MS;
  for (;;) {
    let tasks: readonly TaskView[];
    try {
      const response = await fetch(brokerUrl);
      if (!response.ok) throw new Error(`GET /api/state -> ${response.status}`);
      const state = await response.json() as { tasks?: TaskView[] };
      tasks = state.tasks ?? [];
    } catch (error) {
      // Broker down, restarting, or unreachable. Back off and keep the stdio
      // connection alive; exiting would take the channel's events with it.
      console.error("[inter-channel] broker unreachable, retrying", error);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      await sleep(backoffMs);
      continue;
    }
    backoffMs = POLL_INTERVAL_MS;
    for (const event of watcher.apply(tasks)) {
      // A notification error means the client is gone (session closed); let it
      // surface and end the process rather than spin against a closed transport.
      await mcp.server.notification(event);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ? `: ${body.error}` : "";
  } catch {
    return "";
  }
}

if (import.meta.main) {
  await main();
}
