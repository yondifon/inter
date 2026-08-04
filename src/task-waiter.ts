import type { Task, TaskState } from "./types";

export interface TaskWaitResult {
  reason: "attention" | "progress" | "timeout";
  tasks: Task[];
  cursor: number;
  events?: Array<{
    id: number;
    taskId: string;
    type: string;
    state: Task["state"];
    at: string;
    summary: string;
  }>;
  progress?: Record<string, {
    elapsedMs: number;
    silentMs: number;
    stalled: boolean;
    at: string;
  }>;
  hasMore?: boolean;
}

export type WaitUntil = "progress" | "attention";

type Listener = (taskId?: string) => void;
const POLL_INTERVAL_MS = 100;

export class TaskWaiter {
  private readonly listeners = new Set<Listener>();
  // Polls only read `state`; the optional probe makes that a two-column read
  // instead of a full row. Direct constructions without it fall back to
  // deriving state from getTask, which keeps the unknown-id throw here.
  // (That fallback is a test convenience, not the production path.)
  private readonly getStates: (ids: string[]) => Map<string, TaskState>;

  constructor(
    private readonly getTask: (id: string) => Task | undefined,
    private readonly getCursor: (ids: string[]) => number = () => 0,
    getStates?: (ids: string[]) => Map<string, TaskState>,
  ) {
    this.getStates = getStates ?? ((ids) => {
      const states = new Map<string, TaskState>();
      for (const id of ids) {
        const task = this.getTask(id);
        if (!task) throw new Error(`unknown task: ${id}`);
        states.set(id, task.state);
      }
      return states;
    });
  }

  notify(taskId: string): void {
    for (const listener of [...this.listeners]) listener(taskId);
  }

  async wait(
    taskIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    afterCursor?: number,
    until: WaitUntil = "progress",
  ): Promise<TaskWaitResult> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) throw new Error("at least one task ID is required");
    if (signal?.aborted) throw new Error("wait cancelled");

    const current = this.tasks(ids);
    const baseline = afterCursor ?? this.getCursor(ids);
    // A cursor is the high-water mark of the id set that produced it. Carrying
    // one to a smaller set would otherwise hand back a lower number and replay
    // events the caller already saw.
    const cursor = () => Math.max(afterCursor ?? 0, this.getCursor(ids));
    if (current.some((task) => needsAttention(task.state))) {
      return { reason: "attention", tasks: current, cursor: cursor() };
    }
    if (until === "progress" && afterCursor !== undefined && this.getCursor(ids) > afterCursor) {
      return { reason: "progress", tasks: current, cursor: cursor() };
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poller: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (poller) clearInterval(poller);
        this.listeners.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (result: TaskWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("wait cancelled"));
      };
      const onChange: Listener = (changedId) => {
        if (changedId && !ids.includes(changedId)) return;
        try {
          // Decide from the probe before paying for full rows: the common case
          // is no news, and a full row exists only to be thrown away then.
          const states = this.getStates(ids);
          for (const id of ids) if (!states.has(id)) throw new Error(`unknown task: ${id}`);
          const latest = this.getCursor(ids);
          const cursor = Math.max(afterCursor ?? 0, latest);
          const attention = ids.some((id) => needsAttention(states.get(id)!));
          if (attention || (until === "progress" && latest > baseline)) {
            const tasks = this.tasks(ids);
            finish({ reason: attention ? "attention" : "progress", tasks, cursor });
          }
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
      };

      this.listeners.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      poller = setInterval(() => onChange(), POLL_INTERVAL_MS);
      timer = setTimeout(() => finish({
        reason: "timeout",
        tasks: this.tasks(ids),
        cursor: Math.max(afterCursor ?? 0, this.getCursor(ids)),
      }), timeoutMs);
      onChange();
    });
  }

  private tasks(ids: string[]): Task[] {
    return ids.map((id) => {
      const task = this.getTask(id);
      if (!task) throw new Error(`unknown task: ${id}`);
      return task;
    });
  }
}

function needsAttention(state: TaskState): boolean {
  return state === "needs_input" || state === "blocked" ||
    state === "completed" || state === "failed" || state === "cancelled";
}
