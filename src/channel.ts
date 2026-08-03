#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// The channel is a Claude Code-only accelerator on top of Inter's portable
// follow-along (a blocking `wait` call with until: "attention"), not a
// replacement for it. `notifications/claude/channel` is an Anthropic
// extension, so codex, opencode, and antigravity cannot receive these
// events; those clients follow tasks with `wait`.
export const CHANNEL_INSTRUCTIONS = [
  "You receive delegated Inter task events as <channel source=\"inter\" ...> tags; a task reaching your attention here is also reachable any time with Inter's wait tool (until: \"attention\" works in every client). Handle by state:",
  "needs_input — the worker asked a question. Answer it directly with Inter's reply tool (task_id in the tag) when the answer is reversible and stays within the task's existing scope, or is a scope expansion you can already justify — reply accepts a scope granting paths with the answer. Do not bounce these to the user.",
  "completed — verify the result before treating the work as done.",
  "failed or blocked — read the reason in the tag, then decide whether to resume the task or re-delegate it.",
  "Escalate to the user only for product intent, secrets, destructive actions, or authority the user has not already granted.",
].join(" ");

const brokerUrl = `http://127.0.0.1:${Number(Bun.env.INTER_PORT ?? 7331)}/api/state`;
const POLL_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_TRACKED_TASKS = 1_024;

// Polling `/api/state` on an interval rather than long-polling
// `/api/tasks/:id/events` per task: it gives a whole-broker view in one
// request, needs no prior knowledge of task ids, and survives broker
// restarts that a per-task cursor would miss.
export const WORTHY_STATES = new Set(["needs_input", "completed", "failed", "blocked"]);

// The fields of a task the watcher reads to build an event: a structural
// subset of Task (src/types.ts) so tests need not construct the whole row.
export interface TaskView {
  id: string;
  profileId: string;
  cwd: string;
  state: string;
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
      },
    },
  };
}

export function eventContent(task: TaskView): string {
  const { id, cwd } = task;
  switch (task.state) {
    case "needs_input":
      return [
        `Inter task ${id} needs your input.`,
        `question: ${task.question ?? "(no question recorded)"}`,
        `profile: ${task.profileId}`,
        `cwd: ${cwd}`,
        `Answer with Inter's reply tool (task_id: ${id}).`,
      ].join("\n");
    case "completed":
      return `Inter task ${id} completed.\n${shortOutcome(task)}\ncwd: ${cwd}`;
    case "failed":
      return `Inter task ${id} failed.\n${reasonLine(task)}\ncwd: ${cwd}`;
    case "blocked":
      return `Inter task ${id} is blocked.\n${reasonLine(task)}\ncwd: ${cwd}`;
    default:
      return `Inter task ${id} is ${task.state}.`;
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

if (import.meta.main) {
  await main();
}
