import { observeStateStore } from "./store";
import type { InFlightTask } from "./store";

/**
 * What killing the broker right now would cost.
 *
 * `make install` retires the running broker on purpose, and until now it did
 * that silently — two real tasks were destroyed mid-run by exactly that. The
 * broker's own recovery is honest about each worker afterwards, but the user
 * still deserves the number before the kill rather than the wreckage after it.
 */
export function inFlightReport(tasks: InFlightTask[]): string {
  if (tasks.length === 0) return "No tasks in flight.";
  const lines = tasks.map(({ id, state, title, pid }) => {
    const label = title ? `  ${title}` : "";
    return `  ${id}  ${state}${pid ? `  pid ${pid}` : "  no worker"}${label}`;
  });
  const count = `${tasks.length} task${tasks.length === 1 ? "" : "s"} in flight`;
  return [
    `${count}. Restarting the broker stops ${tasks.length === 1 ? "it" : "them"}:`,
    ...lines,
    "",
    "Workers that outlive the broker are stopped and recorded `cancelled`; their",
    "provider sessions are kept, so `resume` continues them where they left off.",
  ].join("\n");
}

/**
 * Read-only by construction: `observeStateStore` opens the database without
 * claiming the broker's startup duties. Opening it as the broker would run
 * interrupted-task recovery, so a command whose whole job is to *warn* about
 * losing workers would be the thing that reaped them.
 */
export function runInflight(): number {
  const store = observeStateStore();
  const tasks = store.inFlightTasks();
  console.log(inFlightReport(tasks));
  return tasks.length > 0 ? 1 : 0;
}
