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
      ? "Root provider session mapped"
      : event.type === "handed_off"
      ? `${string(event.payload.fromProfile) ?? "?"} → ${string(event.payload.toProfile) ?? "?"}`
      : event.type === "handoff_brief"
      ? joinDetail(
        `${string(event.payload.tier) ?? "brief"} carry-over`,
        `${Number(event.payload.chars ?? 0)} chars`,
        event.payload.omittedMessages ? `${Number(event.payload.omittedMessages)} messages omitted` : undefined,
      )
      : dropped
      ?? (event.payload.stalled === true
        ? `No agent event for ${Math.round(Number(event.payload.silentMs ?? 0) / 1_000)}s`
        : event.type === "heartbeat"
          ? `Running for ${Math.round(Number(event.payload.elapsedMs ?? 0) / 1_000)}s`
          : event.type === "needs_input"
            ? truncate((firstString(event.payload.question) ?? "").replace(/\s+/g, " "), 160)
            : event.type === "answered"
              ? truncate((firstString(event.payload.answer) ?? "").replace(/\s+/g, " "), 160)
              : firstString(event.payload.provider, event.payload.model));
    return {
      ...base,
      kind: event.type === "failed" || event.type === "scope_refusal" ? "error" : "lifecycle",
      phase: event.type === "scope_refusal" ? "failed" : phase(event.state),
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
  // Codex names the MCP server outside the tool name (`item.server`), unlike
  // Claude's self-contained `mcp__server__function`. Folded into the title the
  // same way, a failing call reads "Node Repl: Js failed" instead of just
  // naming the generic tool ("Js failed") with no clue which server it hit.
  const server = string(subject.server);
  const input = Object.keys(object(state.input)).length ? object(state.input) : object(subject.input);
  const presentation = toolPresentation(tool, input, firstString(state.title, subject.title), state) ??
    subjectPresentation(subjectType, subject);
  const detail = presentationDetail(presentation) ?? firstString(
    subject.text, subject.thinking, subject.message, subject.command, subject.file_path, subject.path,
    input.filePath, input.file_path, input.path, payload.result,
  );
  // Claude tags a tool_use block with `id` and its result with `tool_use_id`;
  // OpenCode uses `callID` on the part; Codex reuses `item.id` across started
  // and completed. Whichever the provider sent identifies one action.
  const action = firstString(
    subject.callID, subject.call_id, subject.tool_use_id, subject.toolUseId,
    subject.id, payload.tool_use_id,
  );
  const actionId = action ? { actionId: action } : {};
  const meta = findToolMeta(payload, subject.id);

  if (subjectType.includes("error") || status === "failed" || status === "error") {
    const nested = object(subject.error);
    // opencode reports a failed call with `status: "error"` and the reason in
    // `state.error`; the reason is the point of the row, so it joins whatever
    // the arguments already said — same pairing as a failed hook.
    const error = firstString(nested.message, object(nested.data).message, subject.error, state.error);
    // Codex reports two very different things through this same `error` item
    // shape: a genuine abort (out of credits, a rejected request) and a
    // notice the run carries on past (a deprecated config flag, a
    // context-budget trim). Every distinct message seen in the corpus for
    // this shape is one of the two notices below; anything else is treated
    // as a real, terminal error, since missing a real failure is worse than
    // one unnecessary alarm.
    if (!tool && detail && /is deprecated|shortened to fit the/.test(detail)) {
      return { ...base, kind: "lifecycle", phase: "info", title: "Agent notice", detail,
        presentation: { type: "signal", level: "info", text: detail }, ...actionId, rawText };
    }
    return { ...base, kind: "error", phase: "failed",
      title: tool ? `${qualifiedToolTitle(tool, server, meta)} failed` : "Agent error",
      detail: joinDetail(detail, error), ...actionId, rawText };
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
  // A progress ping repeats a call that already has a row: same tool, same id,
  // one more tick of the clock. It is kept reachable and out of the trace.
  if (subjectType.includes("progress") || payload.heartbeat === true) {
    const elapsed = Number(payload.elapsed_time_seconds ?? payload.elapsedSeconds ?? 0);
    return { ...base, kind: "raw", phase: statusPhase(status), title: "Tool progress",
      detail: joinDetail(string(payload.tool_name) ?? tool, elapsed ? `running ${elapsed}s` : undefined),
      ...actionId, minor: true, rawText };
  }
  // "Reasoning", not "Thinking": the trace collapses same-titled "Thinking"
  // ticker events into one pulse line, and prose must not be pulled into it.
  // A block with no prose (redacted thinking carries only a signature) still
  // marks that the model paused to reason — the pulse line and the token
  // ticker already told the reader that in real time, so this block earns no
  // new row of its own. It still needs a non-empty detail, though: a blank
  // "Reasoning" title with nothing under it, even folded away, reads as a
  // rendering bug rather than "nothing happened here worth a line".
  if (subjectType.includes("reason") || subjectType.includes("think")) {
    const redacted = subject.thinking === "" && !detail;
    return { ...base, kind: "reasoning", phase: statusPhase(status), title: "Reasoning",
      detail: detail ?? (redacted ? "Redacted" : undefined),
      ...(detail ? {} : { minor: true }), rawText };
  }
  if (subjectType.includes("command") || normalizedTool === "bash" || normalizedTool === "run_command") {
    // Codex's command_execution items carry no tool name, so the previous
    // `tool ?? "Command"` fallback titled every one of them "Command" — the
    // reader had to open each row to tell them apart. Naming it "Bash" (via
    // toolTitle, same as Claude's own Bash calls) also unifies opencode's
    // split between lowercase "bash" (from the raw tool string on this path)
    // and capitalized "Bash" (from toolTitle on the tool_execution_* path).
    return { ...base, kind: "command", phase: statusPhase(status),
      title: tool ? toolTitle(tool) : "Bash", detail, presentation, ...actionId, rawText };
  }
  if (subjectType.includes("file") || ["read", "write", "edit"].includes(normalizedTool ?? "")) {
    return { ...base, kind: "file", phase: statusPhase(status),
      title: tool ? toolTitle(tool) : "File change", detail, presentation, ...actionId, rawText };
  }
  if (subjectType.includes("tool")) {
    // The tool's result is echoed in `state.output` — for MCP tools a JSON
    // blob that would bury the row. The detail reads from the arguments, and
    // only a reduced count falls back to the output.
    const toolDetail = presentationDetail(presentation) ?? compactOutput(string(state.output));
    if (tool || presentation || toolDetail) {
      return { ...base, kind: "tool", phase: statusPhase(status),
        title: tool ? qualifiedToolTitle(tool, server, meta) : "Tool call",
        detail: toolDetail, presentation, ...actionId, rawText };
    }
    // No name, no readable argument, no readable output: nothing to label.
    // Fall through so a label-less part stays in the raw fallback below
    // instead of rendering a blank "Tool call" row.
  }
  if (subjectType.includes("usage")) {
    return { ...base, kind: "usage", phase: "info", title: "Usage", detail, rawText };
  }
  if (subjectType.includes("message") || subjectType === "text" || typeof subject.text === "string") {
    return { ...base, kind: "message", phase: statusPhase(status),
      title: "Agent message", detail, presentation, rawText };
  }
  // Codex's todo list and web search items fall through to here uncaught, and
  // `presentation` was computed above (subjectPresentation already handles
  // both) but never carried onto the row — the todo count showed with no
  // chip behind it, and a search query was dropped outright since nothing
  // upstream of this line reads `subject.query`. Both are fixed by simply
  // returning what was already built instead of leaving it on the floor.
  return { ...base, kind: "raw", phase: statusPhase(status), title: humanize(subjectType),
    detail, presentation, rawText };
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

  const antigravity = antigravityEvent(base, payload, raw);
  if (antigravity) return antigravity;

  const pi = piEvent(base, payload, raw);
  if (pi) return pi;

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
    // A claude worker spawning its own subagent (the `Task` tool) reports the
    // spawn and its outcome as two system events, both tagged with the
    // spawning call's `tool_use_id` — the trace folds them on that id into
    // one row that opens here and settles to its final status below. Titled
    // "Subagent…", never "Task queued"/"Task completed": those are the
    // broker's own lifecycle rows for the delegated task itself, and reusing
    // them would read as the wrong task finishing.
    if (subtype === "task_started") {
      const description = string(payload.description);
      const taskType = string(payload.task_type);
      const actionId = firstString(payload.tool_use_id, payload.toolUseId);
      return { ...base, kind: "lifecycle", phase: "started", title: "Subagent started",
        detail: joinDetail(description, taskType ? humanize(taskType) : undefined),
        ...(actionId ? { actionId } : {}), ...raw };
    }
    if (subtype === "task_notification") {
      const status = string(payload.status);
      const actionId = firstString(payload.tool_use_id, payload.toolUseId);
      return { ...base, kind: "lifecycle", phase: statusPhase(status),
        title: `Subagent ${status ?? "updated"}`, detail: string(payload.summary),
        ...(actionId ? { actionId } : {}), ...raw };
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
      ...(typeof part.cost === "number" ? { costUsd: part.cost } : {}),
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

/// pi writes one flat JSON line per session event in its own vocabulary: a
/// `session` header, `message_update` deltas carrying the text a block at a
/// time, `tool_execution_*` pairs, and `agent_settled` in place of a result
/// envelope. Nothing above matches, so every row would land as raw JSON.
function piEvent(
  base: EventBase,
  payload: Record<string, any>,
  raw: { rawText?: string },
): TaskEventView | undefined {
  const type = string(payload.type);

  if (type === "session") {
    return { ...base, kind: "lifecycle", phase: "info", title: "Session started",
      detail: joinDetail(string(payload.cwd)), ...raw };
  }

  if (type === "message_update") {
    const delta = object(payload.assistantMessageEvent);
    const deltaType = string(delta.type) ?? "message update";
    const text = string(delta.delta);
    // Deltas, not snapshots: the cumulative message was removed from this event.
    // pi streams a token at a time, so an unfolded row per delta buries the run
    // in one-word lines. A block's assembled content arrives on its own `*_end`
    // boundary — thinking_end and text_end close with the completed text — and
    // again, authoritatively, on message_end; so a delta row carries nothing
    // the trace is missing. The capture path skips thinking deltas; these arms
    // only render for traces that predate that skip.
    if (deltaType === "thinking_delta" && text) {
      return { ...base, kind: "reasoning", phase: "started", title: "Thinking", detail: text,
        minor: true, ...raw };
    }
    // The boundary arrives with the whole block in `content`, not a delta, so
    // this one row is the block: the trace's single "Thinking" line, not one
    // per token.
    if (deltaType === "thinking_end") {
      return { ...base, kind: "reasoning", phase: "info", title: "Thinking",
        detail: string(delta.content), minor: true, ...raw };
    }
    if (deltaType === "text_delta" && text) {
      return { ...base, kind: "message", phase: "info", title: "Agent message", detail: text,
        presentation: { type: "message", text }, minor: true, ...raw };
    }
    // Block boundaries and the tokens of a streamed tool argument have no row
    // worth reading, but they still need an arm here: left to fall through, the
    // generic shapes below title them "Agent message" with an empty body.
    return { ...base, kind: "lifecycle", phase: "info", title: humanize(deltaType),
      minor: true, ...raw };
  }

  if (type === "tool_execution_start" || type === "tool_execution_update" ||
      type === "tool_execution_end") {
    const tool = string(payload.toolName);
    const result = object(payload.result);
    const outcome = Array.isArray(result.content)
      ? contentOutcome(firstString(...result.content.map((block: unknown) => object(block).text)))
      : undefined;
    // pi sends `args: null` on tool_execution_end, so the closing row of an edit
    // has no path to present and would fall back to a raw JSON dump. The edit is
    // still fully described — the patch header names the file and the diff holds
    // the change — so the result is read directly when the arguments are gone.
    const presentation = toolPresentation(tool, object(payload.args))
      ?? piEditPresentation(object(result.details));
    const settled = outcome
      ? { ...(presentation ?? { type: "tool" as const }), outcome }
      : presentation;
    return { ...base,
      kind: settled?.type === "file" ? "file" : settled?.type === "command" ? "command" : "tool",
      phase: type === "tool_execution_end" ? (payload.isError ? "failed" : "completed")
        : type === "tool_execution_update" ? "info" : "started",
      title: tool ? toolTitle(tool) : "Tool call",
      detail: presentationDetail(presentation), presentation: settled,
      ...(string(payload.toolCallId) ? { actionId: string(payload.toolCallId)! } : {}),
      ...raw };
  }

  // pi echoes the prompt back as a user message and opens every assistant reply
  // with an empty one. Neither is the agent talking, and without a branch here
  // both render as "Agent message". The openai-completions adapter hoists the
  // message fields (`role`, `usage`) to the top level while the documented wire
  // contract nests them under `message`; real traces show the flat shape, so it
  // is read first and the nested one kept as the fallback.
  if (type === "message_start" || type === "message_end") {
    const role = string(payload.role) ?? string(object(payload.message).role);
    if (role === "user") {
      return { ...base, kind: "lifecycle", phase: "info", title: "Prompt received",
        minor: true, ...raw };
    }
    if (type === "message_start") {
      return { ...base, kind: "lifecycle", phase: "started", title: "Reply started",
        minor: true, ...raw };
    }
  }

  if (type === "message_end") {
    // The openai-completions adapter hoists the message fields (`role`, usage,
    // `stopReason`) to the top level; the documented wire contract nests them
    // under `message`. Real traces show the flat shape, so it is read first and
    // the nested one kept as the fallback.
    const message = object(payload.message);
    const role = string(payload.role) ?? string(message.role);
    if (role !== "assistant") return undefined;
    const usage = Object.keys(object(payload.usage)).length ? object(payload.usage) : object(message.usage);
    const error = string(payload.errorMessage) ?? string(message.errorMessage);
    // json mode exits 0 whatever happened, so the stop reason is the only place
    // a refusal or an abort is reported.
    const failed = error !== undefined ||
      ["error", "aborted"].includes(string(payload.stopReason) ?? string(message.stopReason) ?? "");
    // pi's `input` already excludes the cache read: a real run reports
    // input 1938 + cacheRead 15104 + output 113 = totalTokens 17155, exactly.
    // Nothing to subtract here, unlike codex whose input_tokens includes the
    // cached part. `reasoning` sits inside `input` (30 of the 1938).
    const cached = Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
    const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
      ? usage.cost.total
      : undefined;
    const costUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof usage.input === "number" ? { tokensIn: usage.input } : {}),
      ...(typeof usage.output === "number" ? { tokensOut: usage.output } : {}),
      ...(cached ? { tokensCached: cached } : {}),
      ...(typeof usage.reasoning === "number" ? { tokensThinking: usage.reasoning } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(error ? { level: "error" as const, text: error } : {}),
    };
    return { ...base, kind: failed ? "error" : "usage", phase: failed ? "failed" : "completed",
      title: failed ? "Turn failed" : "Turn summary",
      detail: joinDetail(string(payload.model) ?? string(message.model), error), presentation, ...raw };
  }

  if (type === "agent_settled") {
    return { ...base, kind: "lifecycle", phase: "completed", title: "Run finished", ...raw };
  }

  if (type === "turn_end") {
    // The turn's own settlement: pi closes exactly one `turn_end` per turn,
    // and the turn's usage rides it (the turn's last assistant message, flat
    // or nested, same read as message_end). One line carries what the turn
    // spent — tokens out, cache, dollars — where a message_end carries only
    // that message's share and a tool-calling turn has several. Folding it
    // away with `minor` keeps a 147-turn run from spamming the watch stream;
    // the line lives for the trace, the event inspector, and the app's
    // run-settlement card. A `turn_end` with no usage at all keeps the plain
    // folded boundary below, so a stream that only borrows pi's vocabulary
    // renders exactly as it did before.
    const message = object(payload.message);
    const usage = Object.keys(object(payload.usage)).length ? object(payload.usage) : object(message.usage);
    if (Object.keys(usage).length === 0) {
      return { ...base, kind: "lifecycle", phase: "completed", title: "Turn end", minor: true, ...raw };
    }
    const error = string(payload.errorMessage) ?? string(message.errorMessage);
    const failed = error !== undefined ||
      ["error", "aborted"].includes(string(payload.stopReason) ?? string(message.stopReason) ?? "");
    const cached = Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
    const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
      ? usage.cost.total
      : undefined;
    const costUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof usage.input === "number" ? { tokensIn: usage.input } : {}),
      ...(typeof usage.output === "number" ? { tokensOut: usage.output } : {}),
      ...(cached ? { tokensCached: cached } : {}),
      ...(typeof usage.reasoning === "number" ? { tokensThinking: usage.reasoning } : {}),
      ...(costUsd !== undefined && costUsd > 0 ? { costUsd } : {}),
      ...(error ? { level: "error" as const, text: error } : {}),
    };
    return { ...base, kind: failed ? "error" : "usage", phase: failed ? "failed" : "completed",
      title: failed ? "Turn failed" : "Turn",
      detail: joinDetail(
        typeof presentation.tokensOut === "number" && presentation.tokensOut > 0
          ? `${formatCount(presentation.tokensOut)} out` : undefined,
        presentation.tokensCached ? `${formatCount(presentation.tokensCached)} cached` : undefined,
        costUsd !== undefined && costUsd > 0 ? formatCost(costUsd) : undefined,
        error,
      ), presentation, minor: true, ...raw };
  }

  // Turn and run boundaries carry nothing the trace shows on its own.
  if (["agent_start", "turn_start", "agent_end"].includes(type ?? "")) {
    return { ...base, kind: "lifecycle", phase: type === "agent_start" || type === "turn_start"
      ? "started" : "completed", title: humanize(type!), minor: true, ...raw };
  }

  if (type === "auto_retry_start" || type === "compaction_start") {
    const title = type === "auto_retry_start" ? "API retry" : "Compacting context";
    const detail = joinDetail(string(payload.reason));
    return { ...base, kind: "lifecycle", phase: "info", title,
      ...(detail ? { detail } : {}),
      presentation: { type: "signal", level: "warning", text: detail ?? title }, ...raw };
  }

  return undefined;
}

/// The file and the change an `edit` result carries once its arguments are
/// gone: the patch header names the target, and pi's diff lines are a marker,
/// the line number, then the text — `-1 state: one`.
function piEditPresentation(details: Record<string, any>): TaskEventPresentation | undefined {
  const path = shortPath(string(/^---[ \t]+(\S+)/m.exec(string(details.patch) ?? "")?.[1]));
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of (string(details.diff) ?? "").split(/\r?\n/)) {
    const match = /^([+-])\d*[ \t]?(.*)$/.exec(line);
    if (match) (match[1] === "-" ? removed : added).push(match[2] ?? "");
  }
  const change = removed.length || added.length
    ? compactChange(removed.join("\n"), added.join("\n"))
    : undefined;
  if (!path && !change) return undefined;
  return { type: "file", ...(path ? { path } : {}), ...(change ? { change } : {}) };
}

/// Antigravity wraps every stream-json line in an `event` envelope whose body
/// sits under a key named after it — `init`, `step_update`, `result` — so none
/// of the provider-neutral shapes above match and each row would otherwise land
/// as raw JSON. Steps carry their own vocabulary too: tool names and PascalCase
/// arguments, mapped here onto the tool shapes this file already presents.
function antigravityEvent(
  base: EventBase,
  payload: Record<string, any>,
  raw: { rawText?: string },
): TaskEventView | undefined {
  const event = string(payload.event);

  if (event === "init") {
    const init = object(payload.init);
    const tools = Array.isArray(init.tools) ? init.tools.length : 0;
    return { ...base, kind: "lifecycle", phase: "info", title: "Session started",
      detail: joinDetail(
        string(init.model),
        tools ? `${tools} tools` : undefined,
        string(init.permission_mode) ? `permission ${init.permission_mode}` : undefined,
      ), ...raw };
  }

  if (event === "result") {
    const result = object(payload.result);
    const usage = object(result.usage);
    const error = string(result.error);
    const failed = error !== undefined || string(result.status) === "ERROR";
    const presentation: TaskEventPresentation = {
      type: "usage",
      ...(typeof result.num_turns === "number" ? { turns: result.num_turns } : {}),
      ...(typeof result.duration_seconds === "number"
        ? { durationMs: Math.round(result.duration_seconds * 1_000) }
        : {}),
      ...tokenCounts(usage),
      ...(error ? { level: "error" as const, text: error } : {}),
    };
    return { ...base, kind: "usage", phase: failed ? "failed" : "completed", title: "Run summary",
      detail: joinDetail(
        presentation.turns ? `${presentation.turns} turn${presentation.turns === 1 ? "" : "s"}` : undefined,
        presentation.durationMs ? formatDuration(presentation.durationMs) : undefined,
        error,
      ), presentation, ...raw };
  }

  if (event !== "step_update") return undefined;

  const step = object(payload.step_update);
  const state = string(step.state);
  const stepPhase: TaskEventView["phase"] = state === "ACTIVE" ? "started"
    : state === "DONE" ? "completed" : "info";
  const stepType = string(step.step_type) ?? "unknown";

  if (stepType === "tool") {
    const info = object(step.tool_info);
    const name = string(info.name) ?? string(step.tool_name);
    const tool = ANTIGRAVITY_TOOLS[name?.toLowerCase() ?? ""] ?? name;
    const outcome = string(info.output);
    const presentation = toolPresentation(tool, antigravityToolInput(object(info.parameters)));
    const settled = outcome
      ? { ...(presentation ?? { type: "tool" as const }), outcome }
      : presentation;
    // ACTIVE and DONE repeat one call under the same step index; the trace
    // folds them into a single row and lifts the output onto it.
    const actionId = typeof step.step_index === "number"
      ? { actionId: `${string(step.conversation_id) ?? "step"}:${step.step_index}` }
      : {};
    return { ...base,
      kind: settled?.type === "file" ? "file" : settled?.type === "command" ? "command" : "tool",
      phase: stepPhase, title: tool ? toolTitle(tool) : "Tool call",
      detail: presentationDetail(presentation), presentation: settled, ...actionId, ...raw };
  }

  if (stepType === "agent_response") {
    // The reply only ever arrives as deltas; the closing event carries usage
    // and no text. Each chunk keeps its own row so they read in order.
    const text = string(step.text_delta);
    if (text) {
      return { ...base, kind: "message", phase: "started", title: "Agent message",
        detail: text, presentation: { type: "message", text }, ...raw };
    }
    const usage = object(step.usage);
    const presentation: TaskEventPresentation = { type: "usage", ...tokenCounts(usage) };
    return { ...base, kind: "usage", phase: stepPhase, title: "Turn completed",
      detail: joinDetail(
        typeof presentation.tokensOut === "number"
          ? `${formatCount(presentation.tokensOut)} tokens out`
          : undefined,
        presentation.tokensCached ? `${formatCount(presentation.tokensCached)} cached` : undefined,
      ), presentation, ...raw };
  }

  if (stepType === "checkpoint") {
    return { ...base, kind: "usage", phase: stepPhase, title: "Checkpoint",
      presentation: { type: "usage", ...tokenCounts(object(step.usage)) }, minor: true, ...raw };
  }

  if (stepType === "user_input") {
    return { ...base, kind: "lifecycle", phase: "info", title: "Prompt received", minor: true, ...raw };
  }

  return { ...base, kind: "raw", phase: stepPhase, title: "Step update", minor: true, ...raw };
}

/// `cache_read_tokens` is reported outside `input_tokens`, unlike Codex, so the
/// input figure is already the uncached one.
function tokenCounts(usage: Record<string, any>): Partial<TaskEventPresentation> {
  return {
    ...(typeof usage.input_tokens === "number" ? { tokensIn: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { tokensOut: usage.output_tokens } : {}),
    ...(usage.cache_read_tokens ? { tokensCached: Number(usage.cache_read_tokens) } : {}),
    ...(usage.thinking_tokens ? { tokensThinking: Number(usage.thinking_tokens) } : {}),
  };
}

const ANTIGRAVITY_TOOLS: Record<string, string> = {
  view_file: "read",
  write_to_file: "write",
  replace_file_content: "edit",
  multi_replace_file_content: "multiedit",
  sed_file: "edit",
  notebook_edit: "edit",
  grep_search: "grep",
  code_search: "grep",
  find_by_name: "glob",
  list_dir: "ls",
  search_web: "websearch",
  read_url_content: "webfetch",
  invoke_subagent: "task",
};

/// Antigravity names tool arguments in PascalCase; rename the ones a row is
/// built from so the shared tool presentation can read them.
const ANTIGRAVITY_ARGS: Record<string, string> = {
  AbsolutePath: "filePath",
  TargetFile: "filePath",
  FilePath: "filePath",
  Path: "path",
  SearchDirectory: "path",
  CommandLine: "command",
  Command: "command",
  Cwd: "cwd",
  Query: "query",
  SearchTerm: "query",
  Pattern: "pattern",
  Url: "url",
  Instruction: "description",
  Explanation: "description",
  Prompt: "prompt",
  Name: "name",
  Includes: "include",
};

function antigravityToolInput(parameters: Record<string, any>): Record<string, any> {
  const input: Record<string, any> = { ...parameters };
  for (const [source, target] of Object.entries(ANTIGRAVITY_ARGS)) {
    if (parameters[source] !== undefined && input[target] === undefined) input[target] = parameters[source];
  }
  return input;
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
    event_dropped: "Large event skipped",
    handed_off: "Handed off to another profile",
    handoff_brief: "Handoff brief built",
    scope_refusal: "Write refused by scope" } as Record<string, string>)[type] ?? humanize(type);
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
  toolsearch: "Tool search",
  taskcreate: "Create task",
  taskupdate: "Update task",
  "run command": "Run command",
  "list permissions": "List permissions",
};

interface McpToolMeta {
  displayName?: string;
  serverDisplayName?: string;
}

/// A tool_use block's own `tool_use_meta` entry, keyed by the id it names —
/// present only on the claude assistant message that made the call, never on
/// the hook events reporting the same call. `subject.id` is that call's id
/// for the shapes this function is fed (see the `action` id derivation
/// above); other providers never populate `tool_use_meta`, so this quietly
/// returns undefined for them.
function findToolMeta(payload: Record<string, any>, id: unknown): McpToolMeta | undefined {
  const key = string(id);
  if (!key || !Array.isArray(payload.tool_use_meta)) return undefined;
  const entry = payload.tool_use_meta.map(object).find((candidate) => candidate.id === key);
  if (!entry) return undefined;
  return { displayName: string(entry.display_name), serverDisplayName: string(entry.server_display_name) };
}

/// `mcp__<server>__<function>` humanized whole ("Mcp Inter Database Local
/// Query") collapses three semantic parts — the MCP marker, the server, the
/// function — into unreadable prose. Claude also ships a `tool_use_meta`
/// entry with the names it already showed the user; prefer that when the
/// caller has it. The hook events reporting the same call carry only the raw
/// name, never the meta, so they fall back to parsing it — in the same
/// "server: function" shape, so a live trace doesn't flip titles as the hook
/// settles onto the row the assistant message opened. When tool_use_meta is
/// present but uses a decorative server display name (e.g., "inter [database]"),
/// ignore it in favor of parsing the canonical server name from mcp__ format.
function mcpToolTitle(name: string, meta?: McpToolMeta): string {
  // Always parse the canonical names from the mcp__ format to ensure
  // consistency across all event shapes (assistant message, hook, opencode
  // flattened). The tool_use_meta server_display_name is decorative, not canonical.
  const parts = name.split("__");
  if (parts.length >= 3) {
    const server = parts[1]!;
    const func = parts.slice(2).join("__");
    // Prefer the parsed canonical form, except when meta provides just a function
    // name (for simpler MCP servers that don't have complex server names).
    if (meta?.displayName && !meta.serverDisplayName?.includes(" ")) {
      // Simple display name without server: just use it
      return meta.displayName;
    }
    return `${humanize(server)}: ${humanize(func)}`;
  }
  if (meta?.displayName) {
    return meta.serverDisplayName ? `${capitalize(meta.serverDisplayName)}: ${meta.displayName}` : meta.displayName;
  }
  return humanize(name);
}

/// Codex names an MCP call's server outside the tool name entirely
/// (`item.server`), rather than folding it into the name the way Claude's
/// `mcp__` prefix does — so the server is layered on here instead of inside
/// `toolTitle`.
function qualifiedToolTitle(tool: string, server?: string, meta?: McpToolMeta): string {
  const title = toolTitle(tool, meta);
  return server ? `${humanize(server)}: ${title}` : title;
}

function toolTitle(tool: string, meta?: McpToolMeta): string {
  if (tool.startsWith("mcp__")) return mcpToolTitle(tool, meta);
  const normalized = tool.toLowerCase();
  const known = TOOL_LABELS[normalized];
  if (known) return known;
  if (normalized === "apply_patch") return "Apply patch";
  if (normalized === "multiedit") return "Multi-edit file";
  if (normalized === "write_file") return "Write file";
  if (normalized === "read_file") return "Read file";
  // OpenCode flattens MCP tool names to `server_function` format. If a tool name
  // contains a hyphen (indicating an MCP server with a multi-word name), split on
  // the first underscore and treat it as an MCP call. Guard against built-in
  // underscore tools like `update_plan` or `apply_patch` (already checked above).
  if (tool.includes("_") && tool.includes("-")) {
    const underscoreIndex = tool.indexOf("_");
    const serverPart = tool.substring(0, underscoreIndex);
    if (serverPart.includes("-")) {
      const functionPart = tool.substring(underscoreIndex + 1);
      return `${humanize(serverPart)}: ${humanize(functionPart)}`;
    }
  }
  // Single-word MCP servers like `inter_delegate` follow the same flattened pattern.
  // Detect them only if they are not in TOOL_LABELS and not file tools.
  if (tool.includes("_") && !isFileTool(tool) && !TOOL_LABELS[normalized]) {
    const parts = tool.split("_");
    if (parts.length === 2) {
      const [server, func] = parts;
      // Only treat as MCP if the server part looks like a known MCP server.
      if (["inter"].includes(server.toLowerCase())) {
        return `${humanize(server)}: ${humanize(func)}`;
      }
    }
  }
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
    // Computed from the tool input at call time — intent, not outcome. Saying
    // "written" here made refused writes read as successful in the trace.
    const lines = content.split(/\r?\n/).length;
    return { type: "file", ...(file ? { path: file } : {}),
      change: `${lines} line${lines === 1 ? "" : "s"}` };
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
  // MCP tools pass arbitrary argument names the curated list never covers
  // (`action`, `sql`, `taskId`…). One short string argument names the call
  // well enough for a line; the rest stays in the raw payload.
  let namedDynamically = false;
  if (parts.length < 2) {
    for (const [key, value] of Object.entries(input)) {
      if (TOOL_ARG_KEYS.includes(key)) continue;
      const text = string(value);
      if (!text) continue;
      parts.push(`${humanize(key)}: ${truncate(text.replace(/\s+/g, " "), 80)}`);
      namedDynamically = true;
      break;
    }
  }
  if (!parts.length) {
    const title = firstString(state.title);
    if (!title) return undefined;
    return { type: "tool", text: truncate(title.replace(/\s+/g, " "), 120) };
  }
  // The status is the call's outcome and the only one the part carries. It
  // rides only the dynamically-named rows: the curated arguments' shape is
  // pinned by older rows that predate the outcome.
  return { type: "tool", text: parts.join(" · "),
    ...(namedDynamically && string(state.status) ? { outcome: string(state.status) } : {}) };
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
  // Codex opens a web search with an empty `query` and fills it in on the
  // completed item — the empty string is dropped like any other blank field,
  // so the row still says nothing until the search actually names something.
  if (subjectType.includes("web_search")) {
    const query = firstString(subject.query);
    if (query) return { type: "tool", text: truncate(query, 120) };
  }
  return undefined;
}

/// Every provider reports a tool's outcome in its own shape: a read carries a
/// line count, an edit a patch, a command its streams, a failure a bare string.
/// Reduce each to the one figure worth putting next to the call.
/**
 * What a tool's returned content says on the row, as opposed to inside it. pi
 * hands back the substance itself — a read returns the whole file, a command
 * its whole output — and shipping that as the outcome put the payload on the
 * line above the payload: a file's first lines quoted beside its own name.
 *
 * A short single line is the exception worth keeping, because that shape is a
 * status rather than content ("Successfully replaced 1 block(s)"). Anything
 * taller is measured instead, and the expansion is where it is read.
 */
function contentOutcome(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split("\n");
  if (lines.length === 1) return truncate(trimmed, 120);
  return plural(lines.length, "line");
}

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

/// MCP tool results arrive as JSON text echoed in `state.output`; the trace
/// reduces them to a count instead of dumping the payload. Short plain-text
/// outputs keep their text on one line.
function compactOutput(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const compact = trimmed.replace(/\s+/g, " ").trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return truncate(compact, 160);
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return `${parsed.length} ${parsed.length === 1 ? "item" : "items"}`;
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed);
      return keys.length ? `${keys.length} ${keys.length === 1 ? "field" : "fields"}` : "empty";
    }
  } catch {
    // Not JSON despite the braces; the one-line form below still fits.
  }
  return truncate(compact, 160);
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
