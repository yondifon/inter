import type { Profile, Provider } from "./types";

export function commandFor(
  profile: Profile,
  prompt: string,
  cwd: string,
  model = profile.model,
  hookUrl?: string,
  effort?: string,
): string[] {
  if (profile.command) {
    return profile.command.map((part) => part
      .replaceAll("{prompt}", prompt)
      .replaceAll("{model}", model)
      .replaceAll("{cwd}", cwd)
      .replaceAll("{effort}", effort ?? ""));
  }

  switch (profile.provider) {
    case "claude":
      return [
        "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model,
        ...(effort ? ["--effort", effort] : []),
        "--permission-mode", "acceptEdits", "--allowedTools", "Bash",
        ...(hookUrl ? ["--settings", claudeHookSettings(hookUrl)] : []),
        prompt,
      ];
    case "codex":
      // Codex's macOS sandbox cannot nest inside Inter's sandbox-exec profile.
      // Inter remains the sole enforcement boundary for the approved task scope.
      return [
        "codex", "exec", "--json", "--model", model,
        // -c values parse as TOML, so the level ships quoted as a string.
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd", cwd, "--skip-git-repo-check", prompt,
      ];
    case "opencode":
      return [
        "opencode", "run", "--format", "json", "--model", model,
        ...(effort ? ["--variant", effort] : []),
        "--dir", cwd, "--auto", prompt,
      ];
    case "antigravity":
      // Inter's outer sandbox enforces task scope. Auto-approve Antigravity's
      // inner prompts so non-interactive tool calls do not stall.
      // agy expects --print to take the prompt as its value, not a trailing
      // positional argument.
      return [
        "agy", "--print", prompt, "--output-format", "stream-json", "--model", model,
        "--new-project", "--add-dir", cwd, "--mode", "accept-edits",
        "--dangerously-skip-permissions",
      ];
    case "pi":
      // pi ships no permission gate and no sandbox, so there is nothing to
      // bypass and nothing that can stall on approval. --no-approve is about
      // project trust, not tools: it keeps the delegated repo's .pi/ settings
      // and extensions from loading, and pi extensions run with full system
      // access. pi has no cwd flag either — it reads process.cwd(), so the
      // spawn's cwd is what scopes the run.
      return [
        "pi", "--mode", "json", "--model", model,
        ...(effort ? ["--thinking", effort] : []),
        "--no-approve",
        // Trailing positional, and pi honours no `--` separator: a prompt
        // opening with `-` parses as an unknown flag, one opening with `@` as
        // a file argument.
        prompt,
      ];
  }
}

/**
 * Every provider {@link resumeCommandFor} knows how to resume is a case in its
 * switch, and that switch is the one place the set is written down. What it
 * cannot resume is a profile carrying its own `command`: Inter did not build
 * that argv, so it has nowhere to put a session id.
 */
export function canResumeSession(profile: Profile): boolean {
  return !profile.command;
}

export function resumeCommandFor(
  profile: Profile,
  prompt: string,
  cwd: string,
  sessionId: string,
  model = profile.model,
  hookUrl?: string,
  effort?: string,
): string[] {
  if (!profile.command) {
    switch (profile.provider) {
      case "claude":
        return [
          "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model,
          ...(effort ? ["--effort", effort] : []),
          "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--resume", sessionId,
          ...(hookUrl ? ["--settings", claudeHookSettings(hookUrl)] : []),
          prompt,
        ];
      case "codex":
        // Resume inherits cwd from the process and scope from Inter's outer sandbox.
        return [
          "codex", "exec", "resume", sessionId, "--json", "--model", model,
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check", prompt,
        ];
      case "opencode":
        return [
          "opencode", "run", "--format", "json", "--model", model,
          ...(effort ? ["--variant", effort] : []),
          "--dir", cwd, "--auto", "--session", sessionId, prompt,
        ];
      case "antigravity":
        return [
          "agy", "--print", prompt, "--output-format", "stream-json", "--model", model,
          "--conversation", sessionId, "--add-dir", cwd, "--mode", "accept-edits",
          "--dangerously-skip-permissions",
        ];
      case "pi":
        // --session-id reopens an exact id with no picker and no confirmation,
        // but it only searches sessions recorded for this cwd. A miss is not an
        // error: pi warns on stderr, starts a fresh session under that id, and
        // still exits 0 — so resume has to run in the original cwd.
        return [
          "pi", "--mode", "json", "--model", model,
          ...(effort ? ["--thinking", effort] : []),
          "--no-approve", "--session-id", sessionId,
          prompt,
        ];
    }
  }
  throw new Error(`profile cannot resume sessions: ${profile.id}`);
}

export function sessionIdFrom(provider: Provider, event: Record<string, unknown>): string | undefined {
  const value = provider === "claude" && (event.type === "system" || event.type === "result")
    ? event.session_id
    : provider === "codex" && event.type === "thread.started"
    ? event.thread_id
    : provider === "opencode" && event.type === "step_start"
    ? event.sessionID
    : provider === "antigravity" && (event.event === "init" || event.event === "result")
    ? event.conversation_id ?? object(event.result).conversation_id
    // pi writes the session header as the very first line and never repeats the
    // id on a later event.
    : provider === "pi" && event.type === "session"
    ? event.id
    : undefined;
  if (typeof value !== "string") return undefined;
  const sessionId = value.trim();
  return sessionId.length > 0 ? sessionId : undefined;
}

const WRITE_TOOLS = new Set(["write", "write_file", "edit", "multiedit", "create_file", "notebookedit"]);

/// Paths a stream event says the worker is writing, across provider shapes:
/// Claude assistant tool_use blocks, OpenCode tool parts, and flat hook-style
/// payloads. Used to flag writes the sandbox is about to refuse.
export function writeTargetsFrom(payload: Record<string, unknown>): string[] {
  // pi streams tool arguments a token at a time, and up to 0.82.x each delta
  // also carried the message so far. Reading those yields truncated paths —
  // `probe` for a write to `probe.txt` — so the deltas are skipped and the call
  // is taken from tool_execution_start and the final message instead.
  if (payload.type === "message_update") return [];
  const targets: string[] = [];
  const visit = (node: unknown) => {
    const subject = object(node);
    const tool = str(subject.tool_name) ?? str(subject.toolName) ?? str(subject.tool) ?? str(subject.name);
    if (!tool || !WRITE_TOOLS.has(tool.toLowerCase())) return;
    const input = {
      ...object(subject.input),
      ...object(object(subject.state).input),
      ...object(subject.tool_input),
      ...object(subject.toolInput),
      // pi names it `args` on tool_execution_* events and `arguments` on the
      // toolCall blocks inside an assistant message.
      ...object(subject.args),
      ...object(subject.arguments),
    };
    const path = str(input.file_path) ?? str(input.filePath) ?? str(input.path);
    if (path) targets.push(path);
  };
  visit(payload);
  visit(payload.item);
  visit(payload.part);
  const content = object(payload.message).content;
  if (Array.isArray(content)) for (const block of content) visit(block);
  return targets;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function claudeHookSettings(url: string): string {
  const handler = [{ matcher: "", hooks: [{ type: "http", url, timeout: 10 }] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: handler,
      PostToolUse: handler,
      PostToolUseFailure: handler,
      SubagentStart: handler,
      SubagentStop: handler,
      Notification: handler,
      StopFailure: handler,
    },
  });
}

export function finalText(profile: Profile, raw: string): string {
  if (profile.provider === "claude") {
    const lines = raw.trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const parsed = JSON.parse(lines[index]!) as { result?: string };
        if (typeof parsed.result === "string") return parsed.result;
      } catch {}
    }
    return raw;
  }

  if (profile.provider === "pi") {
    // pi's assistant content is a block array — text, thinking, toolCall — so
    // the answer is the text blocks of the last assistant message, and the
    // generic string check below would never match it.
    const lines = raw.trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const event = JSON.parse(lines[index]!) as Record<string, unknown>;
        if (event.type !== "message_end") continue;
        const message = object(event.message);
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        const text = message.content
          .map((block) => object(block))
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("");
        if (text.trim()) return text;
        // A refused or aborted turn ends with empty content, and json mode still
        // exits 0. The error is the only answer there is; without it the caller
        // gets the whole transcript back as the result.
        const error = message.errorMessage;
        if (typeof error === "string" && error.trim()) return error;
      } catch {}
    }
    return raw.trim();
  }

  const lines = raw.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(lines[index]!) as Record<string, unknown>;
      const item = object(event.item);
      const part = object(event.part);
      const message = object(event.message);
      // Antigravity closes with `{"event":"result","result":{"response":…}}`,
      // so its answer sits a level below every other provider's.
      const result = object(event.result);
      const text = event.text ?? event.message ?? event.content ?? result.response ?? event.result
        ?? item.text ?? item.message ?? part.text ?? part.message ?? message.content;
      if (typeof text === "string") return text;
    } catch {}
  }
  return raw.trim();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
