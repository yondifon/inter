import type { Profile, TaskState } from "./types";
import type { TaskEvent } from "./store";

export interface TaskEventView {
  id: number;
  taskId: string;
  source: "broker" | Profile["provider"];
  kind: "lifecycle" | "message" | "reasoning" | "tool" | "command" | "file" | "error" | "usage" | "raw";
  phase: "info" | "started" | "completed" | "failed";
  title: string;
  detail?: string;
  rawText?: string;
  createdAt: string;
}

export function taskEventView(event: TaskEvent, provider: Profile["provider"]): TaskEventView {
  const base = {
    id: event.id,
    taskId: event.taskId,
    source: event.type.startsWith("agent.") ? provider : "broker" as const,
    createdAt: event.createdAt,
  };
  const rawText = Object.keys(event.payload).length ? JSON.stringify(event.payload, null, 2) : undefined;
  if (!event.type.startsWith("agent.")) {
    const detail = event.payload.stalled === true
      ? `No agent event for ${Math.round(Number(event.payload.silentMs ?? 0) / 1_000)}s`
      : event.type === "heartbeat"
        ? `Running for ${Math.round(Number(event.payload.elapsedMs ?? 0) / 1_000)}s`
        : firstString(event.payload.provider, event.payload.model);
    return {
      ...base,
      kind: event.type === "failed" ? "error" : "lifecycle",
      phase: phase(event.state),
      title: lifecycleTitle(event.type),
      ...(event.payload.error ? { detail: String(event.payload.error) } : detail ? { detail } : {}),
      ...(rawText ? { rawText } : {}),
    };
  }

  const payload = event.payload;
  const hookName = string(payload.hook_event_name) ?? string(payload.hookEventName);
  if (hookName) {
    const toolName = string(payload.tool_name) ?? string(payload.toolName);
    const detail = toolName ?? firstString(payload.message, payload.error, payload.agent_type);
    if (hookName.includes("ToolUse")) {
      return { ...base, kind: "tool", phase: hookName.startsWith("Pre") ? "started" : hookName.includes("Failure") ? "failed" : "completed",
        title: toolName ?? humanize(hookName), detail, rawText };
    }
    if (hookName.includes("Failure")) {
      return { ...base, kind: "error", phase: "failed", title: humanize(hookName), detail, rawText };
    }
    return { ...base, kind: hookName === "Notification" ? "message" : "lifecycle", phase: "info",
      title: humanize(hookName), detail, rawText };
  }
  const item = object(payload.item);
  const part = object(payload.part);
  const subject = Object.keys(item).length ? item : Object.keys(part).length ? part : payload;
  const subjectType = string(subject.type) ?? string(payload.type) ?? "event";
  const state = object(subject.state);
  const status = string(state.status) ?? string(subject.status);
  const tool = string(subject.tool) ?? string(subject.name);
  const detail = firstString(
    subject.text, subject.message, subject.command, subject.file_path, subject.path,
    object(state.input).filePath, object(state.input).path, state.output, payload.result,
  );

  if (subjectType.includes("error") || status === "failed") {
    return { ...base, kind: "error", phase: "failed", title: tool ? `${tool} failed` : "Agent error", detail, rawText };
  }
  if (subjectType.includes("reason")) {
    return { ...base, kind: "reasoning", phase: statusPhase(status), title: "Reasoning", detail, rawText };
  }
  if (subjectType.includes("command") || tool === "bash" || tool === "run_command") {
    return { ...base, kind: "command", phase: statusPhase(status), title: tool ?? "Command", detail, rawText };
  }
  if (subjectType.includes("file") || ["read", "write", "edit"].includes(tool ?? "")) {
    return { ...base, kind: "file", phase: statusPhase(status), title: tool ? `${capitalize(tool)} file` : "File change", detail, rawText };
  }
  if (subjectType.includes("tool")) {
    return { ...base, kind: "tool", phase: statusPhase(status), title: tool ?? "Tool call", detail, rawText };
  }
  if (subjectType.includes("usage")) {
    return { ...base, kind: "usage", phase: "info", title: "Usage", detail, rawText };
  }
  if (subjectType.includes("message") || subjectType === "text" || typeof subject.text === "string") {
    return { ...base, kind: "message", phase: statusPhase(status), title: "Agent message", detail, rawText };
  }
  return { ...base, kind: "raw", phase: statusPhase(status), title: humanize(subjectType), detail, rawText };
}

function lifecycleTitle(type: string): string {
  return ({ created: "Task queued", started: "Worker started", completed: "Task completed",
    failed: "Task failed", needs_input: "Worker needs input",
    events_truncated: "Event capture limit reached" } as Record<string, string>)[type] ?? humanize(type);
}

function phase(state: TaskState): TaskEventView["phase"] {
  if (state === "failed") return "failed";
  if (state === "completed") return "completed";
  if (state === "running") return "started";
  return "info";
}

function statusPhase(status?: string): TaskEventView["phase"] {
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed" || status === "success") return "completed";
  if (status === "running" || status === "started" || status === "pending") return "started";
  return "info";
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(string).find(Boolean);
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
