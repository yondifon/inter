import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Profile, Provider } from "./types";

// Claude Code's own workspace-boundary check gates any read outside cwd
// behind an approval prompt, independent of --permission-mode — without
// --add-dir, a skill's own reference files sit outside that trusted set and
// every read on them prompts, which a headless run can never answer.
function claudeSkillsDir(profile: Profile): string {
  const configDir = profile.env.CLAUDE_CONFIG_DIR;
  const home = homedir();
  const base = configDir
    ? resolve(configDir.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home))
    : resolve(home, ".claude");
  return resolve(base, "skills");
}

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
        "--add-dir", claudeSkillsDir(profile),
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
          "--add-dir", claudeSkillsDir(profile),
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

/**
 * The reasoning level a run actually used, read back from the provider's own
 * session store. The requested effort is a claim; the session store is the
 * record. Returns undefined when the provider does not persist a reasoning
 * level (or the session id is missing) — never a guess at the requested value.
 */
export function sessionEffortFrom(
  provider: Provider,
  sessionId: string,
  profile?: Profile,
): string | undefined {
  switch (provider) {
    case "opencode":
      return opencodeSessionEffort(sessionId);
    case "pi":
      return piSessionEffort(sessionId, profile);
    default:
      return undefined;
  }
}

// opencode records the session's model as a JSON blob in its `session` table,
// and the effective reasoning level lives in that blob's `variant` field — the
// same value Inter hands over via `--variant`. Both DB generations it has used
// carry the same table shape, so either one answers.
function opencodeSessionEffort(sessionId: string): string | undefined {
  const dataDir = opencodeDataDir();
  if (!dataDir) return undefined;
  const candidates = [
    process.env.OPENCODE_DB,
    "opencode.db",
    "opencode-next.db",
  ].filter((name): name is string => Boolean(name) && name !== ":memory:");
  for (const name of candidates) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    try {
      const db = new Database(path, { create: false, strict: true });
      db.exec("PRAGMA query_only = ON");
      const row = db.query<{ model: string | null }, [string]>(
        "SELECT model FROM session WHERE id = ?",
      ).get(sessionId);
      db.close();
      if (!row?.model) continue;
      const variant = (JSON.parse(row.model) as { variant?: unknown }).variant;
      if (typeof variant === "string" && variant) return variant;
    } catch {}
  }
  return undefined;
}

function opencodeDataDir(): string | undefined {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? resolve(xdg) : join(homedir(), ".local", "share");
  const dir = join(base, "opencode");
  return existsSync(dir) ? dir : undefined;
}

// pi writes one JSON entry per session event to
// `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`; the effective
// thinking level is recorded as a `thinking_level_change` entry, so the last
// one in the file is what the run actually used. The sessions tree can be
// relocated through the profile env vars Inter already forwards.
function piSessionEffort(sessionId: string, profile?: Profile): string | undefined {
  const sessionsRoot = piSessionsRoot(profile);
  if (!sessionsRoot) return undefined;
  let effort: string | undefined;
  for (const file of readdirSync(sessionsRoot, { recursive: true })) {
    if (typeof file !== "string" || !file.endsWith(`_${sessionId}.jsonl`)) continue;
    try {
      const text = readFileSync(join(sessionsRoot, file), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let entry: { type?: unknown; thinkingLevel?: unknown };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }
        if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
          effort = entry.thinkingLevel;
        }
      }
    } catch {}
  }
  return effort;
}

function piSessionsRoot(profile?: Profile): string | undefined {
  const env = profile?.env ?? {};
  const sessionDir = env.PI_CODING_AGENT_SESSION_DIR ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  if (sessionDir) return resolve(sessionDir);
  const agentDir = env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR
    ?? join(homedir(), ".pi", "agent");
  const dir = join(resolve(agentDir), "sessions");
  return existsSync(dir) ? dir : undefined;
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
    return fallbackText(raw);
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
    return fallbackText(raw);
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
  return fallbackText(raw);
}

/** No line of the stream carried a text field. */
export const NO_FINAL_MESSAGE = "(no final message: the provider stream carried no assistant text)";

const MARKER = /^[\t ]*(?:[>#*_\-~`]+[\t ]*)*INTER_(?:RESULT|BLOCKED|NEEDS_INPUT)\s*:/i;

/**
 * What to report when no provider branch found a final message. Returning the
 * raw stream was the old answer, and for a JSONL run it let the transcript
 * masquerade as the worker's own words: `interpretWorkerOutcome` ran its prose
 * regexes over ~100KB of JSON, matched a "permission" mention inside a payload,
 * and filed the task `permission_denied` with a JSON blob as its reason.
 *
 * A worker that simply printed prose still gets that prose back untouched — the
 * fallback exists because provider shapes vary, and something beats nothing. A
 * JSONL stream instead gives back only what it really holds: a marker written
 * into a JSON string, which is where opencode puts it, so `INTER_RESULT` /
 * `INTER_BLOCKED` / `INTER_NEEDS_INPUT` detection keeps working for every
 * provider — and otherwise a note that says outright there was no message.
 */
function fallbackText(raw: string): string {
  const trimmed = raw.trim();
  if (!isEventStream(trimmed)) return trimmed;
  return markerLine(trimmed) ?? NO_FINAL_MESSAGE;
}

/** A JSONL event stream, as opposed to a worker that printed plain text. */
function isEventStream(raw: string): boolean {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("{"));
}

/**
 * The marker as the worker wrote it, recovered from wherever in the event it
 * was nested. `JSON.parse` is what un-escapes it: on the wire the sign-off sits
 * inside a JSON string as `\n`-separated text, where the line-anchored parsing
 * in task-protocol would never see it. Only the marker's own line comes back,
 * so a stream that merely echoes the prompt's instruction hands over that
 * echo — which the same parsing correctly refuses — and not the whole prompt.
 */
function markerLine(raw: string): string | undefined {
  for (const line of raw.split("\n").reverse()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const value of strings(event)) {
      const found = value.split(/\r?\n/).reverse().find((text) => MARKER.test(text));
      if (found) return found.trim();
    }
  }
  return undefined;
}

function* strings(node: unknown): Generator<string> {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const item of node) yield* strings(item);
  else if (node && typeof node === "object") for (const value of Object.values(node)) yield* strings(value);
}

/** Reasons opencode gives for a step that stopped without producing anything. */
const ABORTED_REASONS = new Set(["unknown", "aborted", "error", "cancelled", "canceled"]);

/**
 * Why the turn ended, when it ended without the worker's own words. An opencode
 * generation that dies mid-flight closes on `step_finish` with
 * `reason: "unknown"` and zero output tokens, and the CLI still exits 0 — so it
 * was reported `unverified`, "worker exited without an Inter completion
 * marker", the same report as a worker that did the whole job and signed off
 * wrong. That confusion cost a correct, completed run its diagnosis twice on
 * 2026-08-03, once after $5.75 and 81 turns.
 *
 * Only the last `step_finish` is read, and only when it produced no output, so
 * a run that actually generated text is never described this way.
 */
export function abortedTurn(raw: string): string | undefined {
  for (const line of raw.trim().split("\n").reverse()) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "step_finish") continue;
    const part = object(event.part);
    const reason = str(part.reason);
    const output = Number(object(part.tokens).output ?? 0);
    if (!reason || output > 0 || !ABORTED_REASONS.has(reason.toLowerCase())) return undefined;
    return `the provider ended the turn mid-generation: step_finish reason "${reason}", no output tokens`;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
