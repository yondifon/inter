import { writeTargetsFrom } from "./adapters";
import { taskEventView, type TaskEventView } from "./events";
import type { TaskEvent } from "./store";
import type { Provider, Task } from "./types";

/**
 * How much of the previous run's transcript a handoff may carry verbatim. Well
 * above the digest cap on purpose: moving the actual messages is the whole
 * point of a handoff, and a review that reached its conclusion at turn 40
 * carries that conclusion across only if the words survive.
 */
export const VERBATIM_CAP = 24_000;
/** The lossy tier's ceiling, per the plan's ~8k target. */
export const DIGEST_CAP = 8_000;
/** Conclusions live at the end, so the tail gets most of the digest. */
const DIGEST_MESSAGE_BUDGET = Math.round(DIGEST_CAP * 0.6);
const MAX_WRITTEN_PATHS = 20;

export interface HandoffBrief {
  /** The seed prompt for the destination worker. */
  prompt: string;
  tier: "verbatim" | "digest";
  /** Assistant messages the cap dropped; 0 on the verbatim tier. */
  omittedMessages: number;
  chars: number;
}

interface TranscriptLine {
  kind: "message" | "tool" | "error";
  text: string;
}

export interface HandoffBriefOptions {
  /** The caller's explicit instruction to the next worker, replacing the generic continuation line. */
  instruction?: string;
  /** A fresh session on the same account, instead of a handoff to a new one. */
  sameAccount?: boolean;
}

/**
 * Rebuilds a dead run's context from Inter's own rows so another provider
 * account can pick the task up — or, with `sameAccount`, so a fresh session on
 * the same account can when the old one is unusable. Deterministic — no model in
 * the loop — because this is a transform over stored events, not a judgment
 * call.
 */
export function handoffBrief(
  task: Task,
  events: TaskEvent[],
  provider: Provider,
  options: HandoffBriefOptions = {},
): HandoffBrief {
  const lines = transcript(events, provider);
  const verbatim = render(lines);
  const useVerbatim = verbatim.length <= VERBATIM_CAP;
  const carried = useVerbatim ? { text: verbatim, omittedMessages: 0 } : digest(lines);
  const run = (task.attempts?.length ?? 0) + 1;
  const prompt = [
    "# Original task",
    "This is the task, verbatim, exactly as it was given to the previous worker. It is the contract; nothing below replaces it.",
    "",
    task.prompt,
    "",
    options.sameAccount
      ? `# Fresh session: run ${run} of this task`
      : `# Handoff: run ${run} of this task, on a new account`,
    options.sameAccount
      ? `A previous run of this task on profile \`${task.profileId}\` could not be continued: its provider session is unusable (a hard stop left its history unable to reopen), so its work is reproduced below from Inter's own record of the run. A fresh session starts now.`
      : `A previous worker on profile \`${task.profileId}\` already worked on this task and could not finish. Its provider session cannot be opened from here, so its work is reproduced below from Inter's own record of the run.`,
    "",
    "## Why the previous run ended",
    ...endingLines(task),
    "",
    ...writtenSection(task, events),
    useVerbatim
      ? "## What the previous worker said and did, verbatim"
      : `## What the previous worker said and did (condensed — the full transcript exceeded ${VERBATIM_CAP} characters)`,
    carried.text || "_The previous run produced no readable trace._",
    "",
    "# Your instruction",
    options.instruction?.trim() || "Continue this task from where the previous run stopped. Do not repeat work the trace above shows as already finished, and do not re-read files whose contents it already reports unless you need to verify them. Anything the previous run left unwritten is still yours to produce.",
  ].join("\n");
  return {
    prompt,
    tier: useVerbatim ? "verbatim" : "digest",
    omittedMessages: carried.omittedMessages,
    chars: prompt.length,
  };
}

function endingLines(task: Task): string[] {
  const completion = task.completion;
  return [
    `- Inter state: \`${task.state}\``,
    ...(completion ? [`- Completion code: \`${completion.code}\``] : []),
    ...(completion?.reason ? [`- Reason: ${completion.reason}`] : []),
    ...(task.error && task.error !== completion?.reason ? [`- Error: ${clip(task.error, 1_000)}`] : []),
    ...(completion?.resetsAt
      ? [`- The previous account's rate limit resets at ${completion.resetsAt}.`]
      : []),
    ...(task.question ? [`- It was asking: ${task.question}`] : []),
    ...(task.output.trim()
      ? ["", "Its final message was:", "", quote(clip(task.output.trim(), 2_000))]
      : []),
  ];
}

/**
 * What the run left on disk. Partial output is the strongest thing a handoff can
 * point at: the next worker should read these before rewriting them.
 */
function writtenSection(task: Task, events: TaskEvent[]): string[] {
  const written: string[] = [];
  for (const event of events) {
    if (!event.type.startsWith("agent.")) continue;
    for (const target of writeTargetsFrom(event.payload)) {
      const path = relativize(target, task.cwd);
      if (!written.includes(path)) written.push(path);
    }
  }
  if (written.length === 0) return [];
  const shown = written.slice(0, MAX_WRITTEN_PATHS);
  return [
    "## Files the previous run wrote or tried to write",
    ...shown.map((path) => `- ${path}`),
    ...(written.length > shown.length ? [`- (${written.length - shown.length} more)`] : []),
    "Check these on disk before rewriting them; a run that died mid-write may have left one partial.",
    "",
  ];
}

/**
 * One line per thing the worker said or did, provider-neutral. `taskEventView`
 * already normalizes every provider's stream shape, so the brief reads the same
 * rows the app's trace does rather than re-deriving them. Reasoning blocks are
 * left out: they are the largest thing in a trace and the least load-bearing
 * once the conclusions are carried.
 */
function transcript(events: TaskEvent[], provider: Provider): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  // The view behind the last message line, which is only meaningful while that
  // line is still the newest one — skipped events push nothing, so a message
  // following one still belongs to the message before it.
  let previousMessage: TaskEventView | undefined;
  const seenCalls = new Set<string>();
  for (const event of events) {
    if (!event.type.startsWith("agent.") && event.type !== "scope_refusal") continue;
    const view = taskEventView(event, provider);
    const detail = view.detail?.trim();
    if (view.kind === "message") {
      const chunk = rawDelta(event.payload) ?? detail;
      if (!chunk) continue;
      const last = lines.at(-1);
      // Two providers stream a reply a chunk at a time (pi as minor deltas,
      // Antigravity as `started` fragments), and a fragment is not a message:
      // splitting them would spend the digest's whole budget on single words.
      // Whole messages from separate turns stay separate, because the digest
      // keeps and drops them one at a time.
      if (last?.kind === "message" && previousMessage && streamed(view) && streamed(previousMessage)) {
        last.text += chunk;
      } else {
        lines.push({ kind: "message", text: chunk });
      }
      previousMessage = view;
      continue;
    }
    if (view.kind === "error") {
      lines.push({ kind: "error", text: join(view.title, detail) });
      continue;
    }
    // Tool calls only: results repeat a call that already has a line, and the
    // trace marks them minor for exactly that reason.
    if (view.minor) continue;
    if (view.kind === "tool" || view.kind === "file" || view.kind === "command") {
      const text = join(view.title, detail);
      if (repeatsCall(view, text, seenCalls, lines.at(-1))) continue;
      if (view.actionId) seenCalls.add(view.actionId);
      lines.push({ kind: "tool", text });
    }
  }
  return lines;
}

/**
 * Inter stores several rows per tool call — the agent's own echo of the call, a
 * pre-hook, a post-hook — and each renders the same line, which is where three
 * quarters of a real brief went. Every provider tags those rows with one action
 * id, so the id is the call's identity: rows sharing it are one call, while a
 * worker reading the same file twice gets two ids and keeps both lines. Without
 * an id the floor is the line just before, which only folds a repeat that is
 * already adjacent. A failed row is never folded away: the failure is the point
 * of that row, and the call's earlier rows say nothing about it.
 */
function repeatsCall(
  view: TaskEventView,
  text: string,
  seen: Set<string>,
  last?: TranscriptLine,
): boolean {
  if (view.phase === "failed") return false;
  return view.actionId ? seen.has(view.actionId) : last?.kind === "tool" && last.text === text;
}

function streamed(view: TaskEventView): boolean {
  return view.minor === true || view.phase === "started";
}

/**
 * The trace trims every string it presents, which is right for a row and wrong
 * for a token: rejoining trimmed chunks welds words together. pi and Antigravity
 * are the two providers that stream a reply in pieces, so their delta fields are
 * read raw and everything else keeps the view's text.
 */
function rawDelta(payload: Record<string, unknown>): string | undefined {
  const pi = field(payload.assistantMessageEvent, "delta");
  return pi ?? field(payload.step_update, "text_delta");
}

function field(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const value = (node as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function render(lines: TranscriptLine[]): string {
  return lines.map(label).join("\n");
}

function label(line: TranscriptLine): string {
  // Trimmed here rather than per chunk: a streamed reply is only whole once its
  // pieces are back together.
  if (line.kind === "message") return `[assistant] ${line.text.trim()}`;
  return line.kind === "error" ? `[error] ${line.text}` : `[tool] ${line.text}`;
}

/**
 * The lossy tier. Tool calls collapse to a deduplicated list of what was read
 * and run; the assistant's own words are kept verbatim from the end backwards,
 * because a run's conclusions are the last thing it says. Every drop is stated.
 */
function digest(lines: TranscriptLine[]): { text: string; omittedMessages: number } {
  const messages = lines.filter((line) => line.kind === "message");
  const kept: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = label(messages[index]!);
    if (used + text.length > DIGEST_MESSAGE_BUDGET && kept.length > 0) break;
    // A single message larger than the whole budget still contributes its tail.
    const trimmed = text.length > DIGEST_MESSAGE_BUDGET
      ? `[assistant] …${text.slice(-DIGEST_MESSAGE_BUDGET)}`
      : text;
    kept.unshift(trimmed);
    used += trimmed.length;
  }
  const omittedMessages = messages.length - kept.length;

  const seen = new Set<string>();
  const tools: string[] = [];
  let toolBudget = DIGEST_CAP - used;
  let omittedTools = 0;
  for (const line of lines) {
    if (line.kind === "message") continue;
    const text = label(line);
    if (seen.has(text)) continue;
    seen.add(text);
    if (text.length + 1 > toolBudget) {
      omittedTools++;
      continue;
    }
    toolBudget -= text.length + 1;
    tools.push(text);
  }
  return {
    text: [
      "### What it did (deduplicated)",
      ...(tools.length ? tools : ["_No tool calls recorded._"]),
      ...(omittedTools ? [`(${omittedTools} further distinct tool calls omitted)`] : []),
      "",
      "### What it said, last messages verbatim",
      ...(omittedMessages
        ? [`(${omittedMessages} earlier message${omittedMessages === 1 ? "" : "s"} omitted from the middle of the run; the tail below is kept in full)`]
        : []),
      ...(kept.length ? kept : ["_No assistant messages recorded._"]),
    ].join("\n"),
    omittedMessages,
  };
}

function relativize(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function join(title: string, detail?: string): string {
  return detail ? `${title}: ${detail}` : title;
}

function quote(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
