import type { Task, TaskSummary } from "./types";

export function publicTask(task: Task): Omit<Task, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}

export function publicTaskSummary(task: TaskSummary): Omit<TaskSummary, "sessionId"> {
  const { sessionId: _sessionId, ...value } = task;
  return value;
}
