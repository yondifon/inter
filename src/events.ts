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
  presentation?: TaskEventPresentation;
  rawText?: string;
  createdAt: string;
}

export interface TaskEventPresentation {
  type: "file" | "command" | "message" | "todo";
  path?: string;
  change?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  text?: string;
  completed?: number;
  total?: number;
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
    const input = object(payload.tool_input ?? payload.toolInput);
    const presentation = toolPresentation(toolName, input);
    const detail = presentationDetail(presentation) ??
      firstString(payload.message, payload.error, payload.agent_type);
    if (hookName.includes("ToolUse")) {
      return { ...base, kind: presentation?.type === "file" ? "file"
        : presentation?.type === "command" ? "command" : "tool",
        phase: hookName.startsWith("Pre") ? "started" : hookName.includes("Failure") ? "failed" : "completed",
        title: toolName ? toolTitle(toolName) : humanize(hookName), detail, presentation, rawText };
    }
    if (hookName.includes("Failure")) {
      return { ...base, kind: "error", phase: "failed", title: humanize(hookName), detail, rawText };
    }
    return { ...base, kind: hookName === "Notification" ? "message" : "lifecycle", phase: "info",
      title: humanize(hookName), detail, rawText };
  }
  const item = object(payload.item);
  const part = object(payload.part);
  const message = object(payload.message);
  const content = Array.isArray(message.content) ? object(message.content[0]) : {};
  const subject = Object.keys(item).length ? item
    : Object.keys(part).length ? part
      : Object.keys(content).length ? content : payload;
  const subjectType = string(subject.type) ?? string(payload.type) ?? "event";
  const state = object(subject.state);
  const status = string(state.status) ?? string(subject.status);
  const tool = string(subject.tool) ?? string(subject.name) ?? string(state.tool);
  const input = Object.keys(object(state.input)).length ? object(state.input) : object(subject.input);
  const presentation = toolPresentation(tool, input, firstString(state.title, subject.title), state) ??
    subjectPresentation(subjectType, subject);
  const detail = presentationDetail(presentation) ?? firstString(
    subject.text, subject.message, subject.command, subject.file_path, subject.path,
    input.filePath, input.file_path, input.path, state.output, payload.result,
  );

  if (subjectType.includes("error") || status === "failed") {
    return { ...base, kind: "error", phase: "failed", title: tool ? `${tool} failed` : "Agent error", detail, rawText };
  }
  if (subjectType.includes("reason")) {
    return { ...base, kind: "reasoning", phase: statusPhase(status), title: "Reasoning", detail, rawText };
  }
  if (subjectType.includes("command") || tool === "bash" || tool === "run_command") {
    return { ...base, kind: "command", phase: statusPhase(status),
      title: tool ?? "Command", detail, presentation, rawText };
  }
  if (subjectType.includes("file") || ["read", "write", "edit"].includes(tool ?? "")) {
    return { ...base, kind: "file", phase: statusPhase(status),
      title: tool ? toolTitle(tool) : "File change", detail, presentation, rawText };
  }
  if (subjectType.includes("tool")) {
    return { ...base, kind: "tool", phase: statusPhase(status), title: tool ?? "Tool call", detail, rawText };
  }
  if (subjectType.includes("usage")) {
    return { ...base, kind: "usage", phase: "info", title: "Usage", detail, rawText };
  }
  if (subjectType.includes("message") || subjectType === "text" || typeof subject.text === "string") {
    return { ...base, kind: "message", phase: statusPhase(status),
      title: "Agent message", detail, presentation, rawText };
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

function isFileTool(tool?: string): boolean {
  return ["edit", "multiedit", "write", "read", "apply_patch", "write_file", "read_file"]
    .includes(tool?.toLowerCase() ?? "");
}

function toolTitle(tool: string): string {
  const normalized = tool.toLowerCase();
  if (normalized === "apply_patch") return "Apply patch";
  if (normalized === "multiedit") return "Multi-edit file";
  if (normalized === "write_file") return "Write file";
  if (normalized === "read_file") return "Read file";
  return isFileTool(tool) ? `${capitalize(normalized)} file` : humanize(tool);
}

function toolPresentation(
  tool: string | undefined,
  input: Record<string, any>,
  title?: string,
  state: Record<string, any> = {},
): TaskEventPresentation | undefined {
  const normalized = tool?.toLowerCase();
  if (normalized === "bash" || normalized === "run_command") {
    const command = firstString(input.command, state.command);
    if (!command) return undefined;
    return {
      type: "command",
      command,
      ...(firstString(input.workdir, input.cwd) ? { path: firstString(input.workdir, input.cwd) } : {}),
      ...(firstString(state.status) ? { status: firstString(state.status) } : {}),
      ...(typeof state.exit_code === "number" ? { exitCode: state.exit_code } : {}),
    };
  }
  if (normalized === "todowrite") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const completed = todos.filter((todo) => object(todo).status === "completed").length;
    return { type: "todo", completed, total: todos.length };
  }
  if (!isFileTool(tool)) return undefined;
  const file = shortPath(firstString(
    title, input.filePath, input.file_path, input.path,
  ));
  const oldText = firstRawString(input.oldString, input.old_string, input.oldText, input.old_text);
  const newText = firstRawString(input.newString, input.new_string, input.newText, input.new_text);
  if (oldText !== undefined && newText !== undefined) {
    return { type: "file", ...(file ? { path: file } : {}), change: compactChange(oldText, newText) };
  }
  const content = firstString(input.content, input.text);
  if (content && ["write", "write_file"].includes(tool?.toLowerCase() ?? "")) {
    const lines = content.split(/\r?\n/).length;
    return { type: "file", ...(file ? { path: file } : {}),
      change: `${lines} line${lines === 1 ? "" : "s"} written` };
  }
  return file ? { type: "file", path: file } : undefined;
}

function subjectPresentation(
  subjectType: string,
  subject: Record<string, any>,
): TaskEventPresentation | undefined {
  if (subjectType.includes("command")) {
    const command = firstString(subject.command);
    if (command) {
      return {
        type: "command",
        command,
        ...(firstString(subject.status) ? { status: firstString(subject.status)! } : {}),
        ...(typeof subject.exit_code === "number" ? { exitCode: subject.exit_code } : {}),
      };
    }
  }
  if (subjectType.includes("file")) {
    const changes = Array.isArray(subject.changes) ? subject.changes.map(object) : [];
    const paths = changes.map((change) => firstString(change.path)).filter(Boolean) as string[];
    if (paths.length) {
      const path = `${shortPath(paths[0])}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ""}`;
      const kinds = [...new Set(
        changes.map((change) => firstString(change.kind))
          .filter((kind): kind is string => Boolean(kind)),
      )];
      return { type: "file", path, ...(kinds.length ? { change: kinds.map(humanize).join(", ") } : {}) };
    }
  }
  const text = firstString(subject.text, subject.message);
  if ((subjectType.includes("message") || subjectType === "text") && text) {
    return { type: "message", text };
  }
  const items = Array.isArray(subject.items) ? subject.items : [];
  if (subjectType.includes("todo") && items.length) {
    const completed = items.filter((item) => object(item).completed === true).length;
    return { type: "todo", completed, total: items.length };
  }
  return undefined;
}

function presentationDetail(presentation?: TaskEventPresentation): string | undefined {
  if (!presentation) return undefined;
  switch (presentation.type) {
  case "file": return joinDetail(presentation.path, presentation.change);
  case "command": return presentation.command;
  case "message": return presentation.text;
  case "todo": return `${presentation.completed ?? 0} of ${presentation.total ?? 0} complete`;
  }
}

function compactChange(oldText: string, newText: string): string {
  const oldLines = oldText.trim().split(/\r?\n/);
  const newLines = newText.trim().split(/\r?\n/);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = oldLines.slice(start, oldEnd);
  const added = newLines.slice(start, newEnd);
  if (removed.length === 1 && added.length === 1) {
    return compactReplacement(removed[0]!, added[0]!);
  }
  const count = Math.max(removed.length, added.length);
  return `${count} line${count === 1 ? "" : "s"} changed`;
}

function compactReplacement(oldLine: string, newLine: string): string {
  let start = 0;
  while (start < oldLine.length && start < newLine.length && oldLine[start] === newLine[start]) start++;
  let oldEnd = oldLine.length;
  let newEnd = newLine.length;
  while (oldEnd > start && newEnd > start && oldLine[oldEnd - 1] === newLine[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const token = /[A-Za-z0-9_$-]/;
  while (start > 0 && token.test(oldLine[start - 1]!) && token.test(newLine[start - 1]!)) start--;
  while (oldEnd < oldLine.length && token.test(oldLine[oldEnd]!)) oldEnd++;
  while (newEnd < newLine.length && token.test(newLine[newEnd]!)) newEnd++;
  const before = oldLine.slice(start, oldEnd).trim() || "∅";
  const after = newLine.slice(start, newEnd).trim() || "∅";
  return `${truncate(before, 60)} → ${truncate(after, 60)}`;
}

function shortPath(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : value;
}

function joinDetail(...parts: Array<string | undefined>): string | undefined {
  const values = parts.filter((part): part is string => Boolean(part));
  return values.length ? values.join(" · ") : undefined;
}

function firstRawString(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === "string") as string | undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
