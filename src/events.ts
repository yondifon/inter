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
  /// Provider-issued id for the action this event describes. One tool call
  /// arrives as several events — the agent's own echo, a pre-hook, a post-hook,
  /// and the result — and every provider tags them with the same id: Claude's
  /// `tool_use_id`, OpenCode's `callID`, Codex's `item.id`. Rows sharing one
  /// carry one action, so the trace can fold them into a single line.
  actionId?: string;
  /// Plumbing the trace folds away by default: token tickers, step boundaries,
  /// duplicate tool results, hook bookkeeping, quiet heartbeats.
  minor?: boolean;
}

export interface TaskEventPresentation {
  type: "file" | "command" | "message" | "todo" | "tool" | "usage" | "signal";
  path?: string;
  change?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  text?: string;
  completed?: number;
  total?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  tokensThinking?: number;
  /// What the action produced, once its result arrives: lines read, lines
  /// changed, output emitted. The trace folds this onto the row that made the
  /// call, so the result event itself never needs one.
  outcome?: string;
  turns?: number;
  durationMs?: number;
  level?: "info" | "warning" | "error";
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
    const dropped = event.type === "event_dropped"
      ? `${formatBytes(Number(event.payload.bytes ?? 0))} payload over the ${formatBytes(Number(event.payload.limit ?? 0))} line limit — one event skipped, the trace continues`
      : undefined;
    const detail = event.type === "session_captured"
      ? firstString(event.payload.sessionId)
      : dropped
      ?? (event.payload.stalled === true
        ? `No agent event for ${Math.round(Number(event.payload.silentMs ?? 0) / 1_000)}s`
        : event.type === "heartbeat"
          ? `Running for ${Math.round(Number(event.payload.elapsedMs ?? 0) / 1_000)}s`
          : firstString(event.payload.provider, event.payload.model));
    return {
      ...base,
      kind: event.type === "failed" ? "error" : "lifecycle",
      phase: phase(event.state),
      title: lifecycleTitle(event.type),
      ...(event.payload.error ? { detail: String(event.payload.error) } : detail ? { detail } : {}),
      ...(dropped ? { presentation: { type: "signal" as const, level: "warning" as const, text: dropped } } : {}),
      ...(rawText ? { rawText } : {}),
      ...(event.type === "heartbeat" && event.payload.stalled !== true ? { minor: true } : {}),
    };
  }

  const payload = event.payload;
  const hookName = string(payload.hook_event_name) ?? string(payload.hookEventName);
  if (hookName) {
    const toolName = string(payload.tool_name) ?? string(payload.toolName);
    const input = object(payload.tool_input ?? payload.toolInput);
    const presentation = toolPresentation(toolName, input);
    const failed = hookName.includes("Failure");
    const error = firstString(payload.error, object(payload.tool_response).error);
    // On a failure the reason is the point of the row; the tool's own summary
    // (a file path, a command) alone would say nothing about what went wrong.
    const detail = failed
      ? joinDetail(presentationDetail(presentation), error)
      : presentationDetail(presentation) ??
        firstString(payload.message, payload.error, payload.agent_type);
    const actionId = firstString(payload.tool_use_id, payload.toolUseId);
    if (hookName.includes("ToolUse")) {
      return { ...base, kind: presentation?.type === "file" ? "file"
        : presentation?.type === "command" ? "command" : "tool",
        phase: hookName.startsWith("Pre") ? "started" : failed ? "failed" : "completed",
        title: toolName ? toolTitle(toolName) : humanize(hookName), detail, presentation,
        ...(actionId ? { actionId } : {}), rawText };
    }
    if (failed) {
      return { ...base, kind: "error", phase: "failed", title: humanize(hookName), detail,
        ...(actionId ? { actionId } : {}), rawText };
    }
    return { ...base, kind: hookName === "Notification" ? "message" : "lifecycle", phase: "info",
      title: humanize(hookName), detail, rawText };
  }
  const known = knownAgentEvent(base, payload, rawText);
  if (known) return known;

  const item = object(payload.item);
  const part = object(payload.part);
  const message = object(payload.message);
  const content = pickContentBlock(message.content);
  const subject = Object.keys(item).length ? item
    : Object.keys(part).length ? part
      : Object.keys(content).length ? content : payload;
  const subjectType = string(subject.type) ?? string(payload.type) ?? "event";
  const state = object(subject.state);
  const status = string(state.status) ?? string(subject.status);
  const tool = string(subject.tool) ?? string(subject.name) ?? string(state.tool);
  const normalizedTool = tool?.toLowerCase();
  const input = Object.keys(object(state.input)).length ? object(state.input) : object(subject.input);
  const presentation = toolPresentation(tool, input, firstString(state.title, subject.title), state) ??
    subjectPresentation(subjectType, subject);
  const detail = presentationDetail(presentation) ?? firstString(
    subject.text, subject.thinking, subject.message, subject.command, subject.file_path, subject.path,
    input.filePath, input.file_path, input.path, state.output, payload.result,
  );
  // Claude tags a tool_use block with `id` and its result with `tool_use_id`;
  // OpenCode uses `callID` on the part; Codex reuses `item.id` across started
  // and completed. Whichever the provider sent identifies one action.
  const action = firstString(
    subject.callID, subject.call_id, subject.tool_use_id, subject.toolUseId,
    subject.id, payload.tool_use_id,
  );
  const actionId = action ? { actionId: action } : {};

  if (subjectType.includes("error") || status === "failed") {
    const nested = object(subject.error);
    return { ...base, kind: "error", phase: "failed", title: tool ? `${tool} failed` : "Agent error",
      detail: detail ?? firstString(nested.message, object(nested.data).message, subject.error),
      ...actionId, rawText };
  }
  // Tool results echo work the matching tool event already reported, so the row
  // stays folded away — but the result is the only place the outcome is stated,
  // and the trace lifts that onto the call.
  if (subjectType.includes("tool_result")) {
    const outcome = toolResultOutcome(payload.tool_use_result ?? payload.toolUseResult);
    return { ...base, kind: "raw", phase: subject.is_error === true ? "failed" : "info",
      title: "Tool result", detail: detail ?? blockText(subject.content),
      ...(outcome ? { presentation: { type: "tool" as const, outcome } } : {}),
      ...actionId, minor: true, rawText };
  }
  // "Reasoning", not "Thinking": the trace collapses same-titled "Thinking"
  // ticker events into one pulse line, and prose must not be pulled into it.
  // A block with no prose (redacted thinking carries only a signature) marks
  // that the model paused, which is not worth a row.
  if (subjectType.includes("reason") || subjectType.includes("think")) {
    return { ...base, kind: "reasoning", phase: statusPhase(status), title: "Reasoning", detail,
      ...(detail ? {} : { minor: true }), rawText };
  }
  if (subjectType.includes("command") || normalizedTool === "bash" || normalizedTool === "run_command") {
    return { ...base, kind: "command", phase: statusPhase(status),
      title: tool ?? "Command", detail, presentation, ...actionId, rawText };
  }
  if (subjectType.includes("file") || ["read", "write", "edit"].includes(normalizedTool ?? "")) {
    return { ...base, kind: "file", phase: statusPhase(status),
      title: tool ? toolTitle(tool) : "File change", detail, presentation, ...actionId, rawText };
  }
  if (subjectType.includes("tool")) {
    return { ...base, kind: "tool", phase: statusPhase(status),
      title: tool ? toolTitle(tool) : "Tool call", detail, presentation, ...actionId, rawText };
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

type EventBase = Pick<TaskEventView, "id" | "taskId" | "source" | "createdAt">;

/// Provider payload shapes this app knows how to present without dumping JSON:
/// run receipts, per-turn usage, thinking progress, session boot, retries, and
/// rate limits. Anything unmatched falls through to the generic subject flow.
function knownAgentEvent(
  base: EventBase,
  payload: Record<string, any>,
  rawText?: string,
): TaskEventView | undefined {
  const payloadType = string(payload.type);
  const raw = rawText ? { rawText } : {};

  if (payloadType === "system") {
    const subtype = string(payload.subtype);
    if (subtype === "thinking_tokens") {
      const tokens = Math.max(0, Number(payload.estimated_tokens ?? 0));
      // The counter restarts each turn, so the run total is only recoverable by
      // adding the deltas up. Carry it; the trace sums what it collects.
      const delta = Math.max(0, Number(payload.estimated_tokens_delta ?? 0));
      return { ...base, kind: "reasoning", phase: "started", title: "Thinking",
        detail: `~${formatCount(tokens)} tokens so far`,
        ...(delta ? { presentation: { type: "usage" as const, tokensThinking: delta } } : {}),
        minor: true, ...raw };
    }
    if (subtype === "init") {
      const tools = Array.isArray(payload.tools) ? payload.tools.length : 0;
      const servers = Array.isArray(payload.mcp_servers) ? payload.mcp_servers.length : 0;
      return { ...base, kind: "lifecycle", phase: "info", title: "Session started",
        detail: joinDetail(
          string(payload.model),
          tools ? `${tools} tools` : undefined,
          servers ? `${servers} MCP server${servers === 1 ? "" : "s"}` : undefined,
          string(payload.permissionMode) ? `permission ${payload.permissionMode}` : undefined,
        ), ...raw };
    }
    if (subtype === "api_retry") {
      const attempt = Number(payload.attempt ?? 0);
      const max = Number(payload.max_retries ?? 0);
      const delay = Number(payload.retry_delay_ms ?? 0);
      const error = string(payload.error);
      const text = joinDetail(
        max ? `Attempt ${attempt} of ${max}` : `Attempt ${attempt}`,
        delay ? `retry in ${formatDuration(delay)}` : undefined,
        error && error !== "unknown" ? error : undefined,
      ) ?? "API retry";
      return { ...base, kind: "lifecycle", phase: "info", title: "API retry",
        detail: text, presentation: { type: "signal", level: "warning", text }, ...raw };
    }
    // Remaining subtypes are plumbing; still name what happened instead of
    // leaving a bare JSON row.
    if (subtype === "hook_started" || subtype === "hook_response") {
      const outcome = string(payload.outcome);
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
      return { ...base, kind: "lifecycle", phase: outcome === "success" || subtype === "hook_started" ? "info" : "failed",
        title: subtype === "hook_started" ? "Hook started" : "Hook finished",
        detail: joinDetail(
          string(payload.hook_name) ?? string(payload.hook_event),
          outcome,
          exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined,
        ), minor: true, ...raw };
    }
    if (subtype === "commands_changed") {
      const commands = Array.isArray(payload.commands) ? payload.commands.length : 0;
      return { ...base, kind: "lifecycle", phase: "info", title: "Commands loaded",
        ...(commands ? { detail: `${commands} command${commands === 1 ? "" : "s"}` } : {}),
        minor: true, ...raw };
    }
    if (subtype === "status") {
      return { ...base, kind: "lifecycle", phase: "info", title: "Status",
        ...(string(payload.permissionMode) ? { detail: `permission ${payload.permissionMode}` } : {}),
        minor: true, ...raw };
    }
    return { ...base, kind: "raw", phase: "info", title: humanize(subtype ?? "system"), minor: true, ...raw };
  }

  if (payloadType === "result") {
    const usage = object(payload.usage);
    const denials = Array.isArray(payload.permission_denials)
      ? payload.permission_denials.map((denial) => string(object(denial).tool_name)).filter(Boolean) as string[]
      : [];
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof payload.total_cost_usd === "number" ? { costUsd: payload.total_cost_usd } : {}),
      ...(typeof payload.num_turns === "number" ? { turns: payload.num_turns } : {}),
      ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
      ...(typeof usage.output_tokens === "number" ? { tokensOut: usage.output_tokens } : {}),
      ...(typeof usage.input_tokens === "number"
        ? { tokensIn: usage.input_tokens + Number(usage.cache_creation_input_tokens ?? 0) }
        : {}),
      ...(typeof usage.cache_read_input_tokens === "number"
        ? { tokensCached: usage.cache_read_input_tokens }
        : {}),
      ...(denials.length
        ? { level: "warning" as const,
            text: `${denials.length} permission denial${denials.length === 1 ? "" : "s"}: ${[...new Set(denials)].join(", ")}` }
        : {}),
    };
    const failed = payload.is_error === true;
    return { ...base, kind: "usage", phase: failed ? "failed" : "completed", title: "Run summary",
      detail: joinDetail(
        typeof presentation.costUsd === "number" ? formatCost(presentation.costUsd) : undefined,
        presentation.turns ? `${presentation.turns} turn${presentation.turns === 1 ? "" : "s"}` : undefined,
        presentation.durationMs ? formatDuration(presentation.durationMs) : undefined,
        presentation.text,
      ), presentation, ...raw };
  }

  if (payloadType === "turn.completed") {
    const usage = object(payload.usage);
    const cached = Number(usage.cached_input_tokens ?? 0);
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof usage.input_tokens === "number"
        ? { tokensIn: Math.max(0, usage.input_tokens - cached) }
        : {}),
      ...(cached ? { tokensCached: cached } : {}),
      ...(typeof usage.output_tokens === "number" ? { tokensOut: usage.output_tokens } : {}),
    };
    return { ...base, kind: "usage", phase: "completed", title: "Turn completed",
      detail: joinDetail(
        typeof presentation.tokensOut === "number"
          ? `${formatCount(presentation.tokensOut)} tokens out`
          : undefined,
        cached ? `${formatCount(cached)} cached` : undefined,
      ), presentation, ...raw };
  }

  if (payloadType === "turn.started") {
    return { ...base, kind: "lifecycle", phase: "started", title: "Turn started", minor: true, ...raw };
  }

  if (payloadType === "thread.started") {
    const thread = string(payload.thread_id);
    return { ...base, kind: "lifecycle", phase: "info", title: "Session started",
      ...(thread ? { detail: thread } : {}), minor: true, ...raw };
  }

  if (payloadType === "step_start" || payloadType === "step_finish") {
    const part = object(payload.part);
    if (payloadType === "step_start") {
      return { ...base, kind: "lifecycle", phase: "started", title: "Step started", minor: true, ...raw };
    }
    const tokens = object(part.tokens);
    const cached = object(tokens.cache);
    const cachedTotal = Number(cached.read ?? 0) + Number(cached.write ?? 0);
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof tokens.input === "number" ? { tokensIn: tokens.input } : {}),
      ...(typeof tokens.output === "number" ? { tokensOut: tokens.output } : {}),
      ...(cachedTotal ? { tokensCached: cachedTotal } : {}),
    };
    return { ...base, kind: "usage", phase: "completed", title: "Step finished",
      detail: joinDetail(
        string(part.reason)?.replaceAll("-", " "),
        typeof tokens.output === "number" ? `${formatCount(tokens.output)} tokens out` : undefined,
      ), presentation, minor: true, ...raw };
  }

  if (payloadType === "rate_limit_event") {
    const info = object(payload.rate_limit_info);
    const status = string(info.status);
    const resetsAt = Number(info.resetsAt ?? 0);
    const remainingMs = resetsAt ? resetsAt * 1_000 - Date.now() : 0;
    const text = joinDetail(
      string(info.rateLimitType)?.replaceAll("_", " "),
      status,
      remainingMs > 0 ? `resets in ${formatDuration(remainingMs)}` : undefined,
      info.isUsingOverage === false && string(info.overageStatus) === "rejected" ? "overage off" : undefined,
    ) ?? "Rate limit";
    const level = status === "allowed" ? "info" as const : "warning" as const;
    return { ...base, kind: "lifecycle", phase: "info", title: "Rate limit",
      detail: text, presentation: { type: "signal", level, text }, ...raw };
  }

  return undefined;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatBytes(value: number): string {
  return value >= 1_024 ? `${Math.round(value / 1_024)} KB` : `${value} B`;
}

function formatCost(value: number): string {
  return value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lifecycleTitle(type: string): string {
  return ({ created: "Task queued", started: "Worker started", completed: "Task completed",
    failed: "Task failed", needs_input: "Worker needs input", answered: "Question answered",
    blocked: "Task blocked", cancelled: "Task cancelled", worker_spawned: "Worker spawned",
    events_truncated: "Event capture limit reached",
    event_dropped: "Large event skipped" } as Record<string, string>)[type] ?? humanize(type);
}

function phase(state: TaskState): TaskEventView["phase"] {
  if (state === "failed" || state === "blocked" || state === "cancelled") return "failed";
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

/// A provider message can carry several content blocks; one row can show only
/// one. Prefer the block with the most signal: a tool call beats prose, prose
/// beats a thinking block, and an empty thinking block (signature only) beats
/// nothing.
function pickContentBlock(content: unknown): Record<string, any> {
  if (!Array.isArray(content) || content.length === 0) return {};
  const blocks = content.map(object);
  const rank = (block: Record<string, any>): number => {
    const type = string(block.type) ?? "";
    if (type.includes("tool_use")) return 0;
    if (type === "text" && string(block.text)) return 1;
    if (type.includes("think") && string(block.thinking)) return 2;
    return 3;
  };
  return [...blocks].sort((a, b) => rank(a) - rank(b))[0] ?? {};
}

/// Flatten a tool_result content value — a plain string or an array of typed
/// blocks — into one line of preview text.
function blockText(content: unknown): string | undefined {
  const text = typeof content === "string" ? content
    : Array.isArray(content)
      ? content.map((block) => string(object(block).text)).filter(Boolean).join(" ")
      : undefined;
  const compact = text?.replace(/\s+/g, " ").trim();
  return compact ? truncate(compact, 160) : undefined;
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

const TOOL_LABELS: Record<string, string> = {
  todowrite: "Todo list",
  todoread: "Todo list",
  websearch: "Web search",
  webfetch: "Fetch page",
  glob: "Find files",
  grep: "Search code",
  ls: "List files",
  list: "List files",
  task: "Subagent",
  agent: "Subagent",
  update_plan: "Plan update",
};

function toolTitle(tool: string): string {
  const normalized = tool.toLowerCase();
  const known = TOOL_LABELS[normalized];
  if (known) return known;
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
  if (normalized === "todowrite" || normalized === "todoread") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const completed = todos.filter((todo) => object(todo).status === "completed").length;
    const active = firstString(
      ...todos.filter((todo) => object(todo).status === "in_progress")
        .map((todo) => object(todo).content ?? object(todo).activeForm),
    );
    return { type: "todo", completed, total: todos.length, ...(active ? { text: active } : {}) };
  }
  if (!isFileTool(tool)) return genericToolPresentation(input, state);
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

/// Arguments worth showing for a tool this app has no dedicated layout for.
const TOOL_ARG_KEYS = [
  "query", "pattern", "url", "description", "prompt",
  "subagent_type", "glob", "include", "name", "path",
];

function genericToolPresentation(
  input: Record<string, any>,
  state: Record<string, any>,
): TaskEventPresentation | undefined {
  const parts: string[] = [];
  for (const key of TOOL_ARG_KEYS) {
    const value = firstString(input[key], input[camelCase(key)]);
    if (!value) continue;
    parts.push(`${humanize(key)}: ${truncate(value.replace(/\s+/g, " "), 80)}`);
    if (parts.length === 2) break;
  }
  if (!parts.length) {
    const title = firstString(state.title);
    if (!title) return undefined;
    return { type: "tool", text: truncate(title.replace(/\s+/g, " "), 120) };
  }
  return { type: "tool", text: parts.join(" · ") };
}

function camelCase(value: string): string {
  return value.replace(/[._-](\w)/g, (_, letter: string) => letter.toUpperCase());
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

/// Every provider reports a tool's outcome in its own shape: a read carries a
/// line count, an edit a patch, a command its streams, a failure a bare string.
/// Reduce each to the one figure worth putting next to the call.
function toolResultOutcome(value: unknown): string | undefined {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact ? truncate(compact, 120) : undefined;
  }
  const result = object(value);
  const file = object(result.file);
  const total = Number(file.totalLines ?? file.numLines ?? 0);
  if (total) {
    const shown = Number(file.numLines ?? 0);
    return shown && shown < total ? `${shown} of ${total} lines` : `${plural(total, "line")} read`;
  }
  const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  if (patch.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      const lines = object(hunk).lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    if (added || removed) return `+${added} −${removed}`;
  }
  if ("stdout" in result || "stderr" in result) {
    if (result.interrupted === true) return "interrupted";
    const text = firstString(result.stdout, result.stderr);
    if (!text) return "no output";
    return `${plural(text.trimEnd().split(/\r?\n/).length, "line")} out`;
  }
  return undefined;
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function presentationDetail(presentation?: TaskEventPresentation): string | undefined {
  if (!presentation) return undefined;
  switch (presentation.type) {
  case "file": return joinDetail(presentation.path, presentation.change);
  case "command": return presentation.command;
  case "message": return presentation.text;
  case "todo": return joinDetail(
    `${presentation.completed ?? 0} of ${presentation.total ?? 0} complete`,
    presentation.text,
  );
  case "tool": return presentation.text;
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
  // Mark the elision: `http/html/csrf.rs` next to a whole `src/http/mod.rs`
  // reads as two different trees rather than one truncated path.
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
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
