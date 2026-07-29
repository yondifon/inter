import type { Task } from "./types";

export interface TaskWaitResult {
  reason: "attention" | "progress" | "timeout";
  tasks: Task[];
  cursor: number;
}

type Listener = (taskId?: string) => void;
const POLL_INTERVAL_MS = 100;

export class TaskWaiter {
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly getTask: (id: string) => Task | undefined,
    private readonly getCursor: (ids: string[]) => number = () => 0,
  ) {}

  notify(taskId: string): void {
    for (const listener of [...this.listeners]) listener(taskId);
  }

  async wait(taskIds: string[], timeoutMs: number, signal?: AbortSignal, afterCursor?: number): Promise<TaskWaitResult> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) throw new Error("at least one task ID is required");
    if (signal?.aborted) throw new Error("wait cancelled");

    const current = this.tasks(ids);
    const baseline = afterCursor ?? this.getCursor(ids);
    if (current.some(needsAttention)) {
      return { reason: "attention", tasks: current, cursor: this.getCursor(ids) };
    }
    if (afterCursor !== undefined && this.getCursor(ids) > afterCursor) {
      return { reason: "progress", tasks: current, cursor: this.getCursor(ids) };
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
          const tasks = this.tasks(ids);
          const cursor = this.getCursor(ids);
          if (tasks.some(needsAttention)) finish({ reason: "attention", tasks, cursor });
          else if (cursor > baseline) finish({ reason: "progress", tasks, cursor });
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
        cursor: this.getCursor(ids),
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

function needsAttention(task: Task): boolean {
  return task.state === "needs_input" || task.state === "completed" || task.state === "failed";
}
