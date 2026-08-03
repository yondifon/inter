import type { CompletionCode, TaskCompletion, TaskScope } from "./types";

const NEEDS_INPUT = /(?:^|\r?\n)[\t ]*(?:INTER_NEEDS_INPUT|NEEDS_INPUT)\s*:\s*([^\r\n]+)[\t ]*(?:\r?\n[\t ]*)*$/i;
// Line-anchored but not end-anchored: workers often append a summary after the
// marker, and that must not turn a done task into blocked/unverified. The line
// anchor keeps instruction echoes ("end with: INTER_RESULT: completed") inert.
const COMPLETED = /(?:^|\r?\n)[\t ]*INTER_RESULT\s*:\s*completed[\t ]*(?=\r?\n|$)/i;
const BLOCKED = /(?:^|\r?\n)[\t ]*INTER_BLOCKED\s*:\s*([a-z_]+)(?:\s*[:|]\s*(.+))?[\t ]*(?:\r?\n[\t ]*)*$/i;
const PERMISSION_BLOCK = /\b(?:awaiting|need(?:ing)?|requires?) (?:your )?(?:permission|approval)\b|\bcannot proceed\b.*\bpermission\b/i;

export interface WorkerOutcome {
  state: "needs_input" | "blocked" | "completed" | "failed";
  output: string;
  question?: string;
  error?: string;
  completion: TaskCompletion;
}

export function workerPrompt(prompt: string, allowQuestions: boolean, scope?: TaskScope): string {
  return [
    prompt,
    "",
    "<inter_protocol>",
    "This reporting protocol is part of the task contract.",
    ...(scope ? [scopeLine(scope)] : []),
    allowQuestions
      ? "If a product choice, secret, destructive action, or new authority is required, stop and end with: INTER_NEEDS_INPUT: <one clear question>"
      : "Do not ask questions. If required information or authority is missing, report a blocked result.",
    "If the requested work is fully done, end with: INTER_RESULT: completed",
    "If work cannot be completed, end with: INTER_BLOCKED: <permission_denied|needs_authority|worker_error> | <short reason>",
    "Emit exactly one of those status lines as the final non-empty line of your final message. Do not claim completion before the work is done.",
    "</inter_protocol>",
  ].join("\n");
}

// Sandbox denials surface inside worker CLIs as bare "operation not permitted"
// errors that name no rule; telling the worker its fence up front is the only
// place that context can come from.
function scopeLine(scope: TaskScope): string {
  const readable = describeRules([...new Set([...scope.read, ...scope.write])]);
  return `File access is OS-enforced relative to your working directory — readable: ${readable}; writable: ${describeRules(scope.write)}. Access outside that scope fails with "operation not permitted"; report it as out of scope instead of retrying.`;
}

function describeRules(rules: string[]): string {
  if (rules.length === 0) return "nothing";
  if (rules.includes("**")) return "the whole working directory";
  const shown = rules.slice(0, 8).join(", ");
  return rules.length > 8 ? `${shown} and ${rules.length - 8} more` : shown;
}

export function continuationPrompt(original: string, question: string, answer: string): string {
  return [
    "# Original task",
    "Treat this as context. The resolved decision below supersedes any conflicting instruction in it.",
    "",
    original,
    "",
    "# Resolved decision",
    `Question: ${question}`,
    `Answer: ${answer}`,
    "",
    "# Current instruction",
    "Continue and finish the original task using the resolved decision. Do not ask the same question again.",
  ].join("\n");
}

export function needsInputQuestion(output: string): string | undefined {
  return output.match(NEEDS_INPUT)?.[1]?.trim() || undefined;
}

// Trailing markdown decoration and closing punctuation around the "?", e.g.
// "**Which language?**" or "Which language?)".
const QUESTION_DECOR = /[\s*_~`"'“”‘’)\]}]+$/;
const LEADING_MARKUP = /^[#>*\-\s]+/;

// Real asks rarely sit on the very last line: workers bold the question, list
// options under it, or close with "(I'll continue once you let me know.)".
// Scan the trailing lines for the question nearest the end.
function proseQuestion(output: string): string | undefined {
  const lines = output.trimEnd().split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(-8).reverse()) {
    const stripped = line.replace(QUESTION_DECOR, "");
    if (!stripped.endsWith("?")) continue;
    return compact(stripped.replace(LEADING_MARKUP, ""));
  }
  return undefined;
}

export function interpretWorkerOutcome(exitCode: number, output: string, stderr: string): WorkerOutcome {
  const question = needsInputQuestion(output);
  if (question) {
    return {
      state: "needs_input",
      output,
      question,
      completion: { exitCode, blocked: true, code: "needs_authority", reason: question },
    };
  }
  if (exitCode !== 0) {
    const error = stderr.trim() || output.trim() || `exit ${exitCode}`;
    const code = classifyFailure(`${stderr}\n${output}`);
    // A rate-limited session is not dead, only paused. The reset time is the
    // difference between "it died" and "it becomes resumable at 12:40am", and
    // it is the input to choosing between waiting and handing off.
    const resetsAt = code === "rate_limit" ? rateLimitResetAt(`${stderr}\n${output}`) : undefined;
    return {
      state: "failed",
      output,
      error,
      completion: {
        exitCode,
        blocked: true,
        code,
        reason: compact(error),
        ...(resetsAt ? { resetsAt } : {}),
      },
    };
  }
  const block = output.match(BLOCKED);
  if (block) {
    const code = completionCode(block[1]);
    const reason = block[2]?.trim() || "worker reported blocked";
    return {
      state: "blocked",
      output,
      completion: { exitCode, blocked: true, code, reason },
    };
  }
  if (COMPLETED.test(output)) {
    return {
      state: "completed",
      output: output.replace(COMPLETED, "").trim(),
      completion: { exitCode, blocked: false, code: "completed" },
    };
  }
  // Most workers ask in prose instead of emitting the needs_input marker; a
  // trailing question is the ask, and classifying it blocked would leave reply
  // unusable for the common case.
  const asked = proseQuestion(output);
  if (asked) {
    return {
      state: "needs_input",
      output,
      question: asked,
      completion: { exitCode, blocked: true, code: "needs_authority", reason: asked },
    };
  }
  if (PERMISSION_BLOCK.test(output)) {
    return {
      state: "blocked",
      output,
      completion: {
        exitCode,
        blocked: true,
        code: "permission_denied",
        reason: compact(output),
      },
    };
  }
  return {
    state: "blocked",
    output,
    completion: {
      exitCode,
      blocked: true,
      code: "unverified",
      reason: "worker exited without an Inter completion marker",
    },
  };
}

// Providers announce the window three ways: an epoch stamp piped onto the
// message (`Claude AI usage limit reached|1754308800`), a countdown ("resets in
// 48m 15s"), or a wall clock with the zone it was printed in ("resets 12:40am
// (Africa/Douala)"). All three were on screen during the 2026-08-03 incident and
// none of them was read.
const RESET_EPOCH = /limit reached\s*\|\s*(\d{9,13})\b/i;
const RESET_IN = /resets?\s+in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*)+)/i;
const RESET_AT =
  /resets?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z][\w+-]*(?:\/[\w+-]+)*)\))?/i;
const DURATION_PART = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

/**
 * When the provider says the rate-limit window clears, as ISO, or undefined
 * when the text names no time. Deterministic and clock-relative, so `now` is
 * injectable for tests.
 */
export function rateLimitResetAt(text: string, now = new Date()): string | undefined {
  const epoch = text.match(RESET_EPOCH)?.[1];
  if (epoch) {
    // Seconds or milliseconds, whichever the provider printed.
    const value = Number(epoch);
    const at = new Date(epoch.length > 10 ? value : value * 1_000);
    return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
  }
  const countdown = text.match(RESET_IN)?.[1];
  if (countdown) {
    let ms = 0;
    for (const [, amount, unit] of countdown.matchAll(DURATION_PART)) {
      const scale = /^h/i.test(unit!) ? 3_600_000 : /^m/i.test(unit!) ? 60_000 : 1_000;
      ms += Number(amount) * scale;
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  const clock = text.match(RESET_AT);
  if (!clock) return undefined;
  const meridiem = clock[3]?.toLowerCase().replace(/\./g, "");
  const rawHour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (rawHour > 23 || minute > 59 || (meridiem && rawHour > 12)) return undefined;
  const hour = meridiem === "am" ? rawHour % 12 : meridiem === "pm" ? (rawHour % 12) + 12 : rawHour;
  // The zone in parentheses is the one the provider formatted the time in; only
  // without it does the broker's own zone apply.
  const offset = (clock[4] ? zoneOffsetMinutes(clock[4], now) : undefined) ?? -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offset * 60_000);
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute)
    - offset * 60_000;
  // A limit that resets at 12:40am, read at 11:50pm, resets tomorrow.
  if (target <= now.getTime()) target += 86_400_000;
  return new Date(target).toISOString();
}

function zoneOffsetMinutes(zone: string, at: Date): number | undefined {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
    const offset = /GMT([+-])(\d{1,2}):(\d{2})/.exec(name);
    if (offset) {
      return (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    }
    return name.includes("GMT") ? 0 : undefined;
  } catch {
    // An unknown zone name is not a reason to lose the time; fall back to local.
    return undefined;
  }
}

export function classifyFailure(value: string): CompletionCode {
  if (/\b(?:insufficient balance|credits?error|billing|payment required)\b/i.test(value)) return "billing";
  if (/\b(?:unauthorized|invalid api key|authentication|not logged in)\b|statusCode["': ]+401/i.test(value)) {
    return "auth";
  }
  // A session or usage limit is a rate limit by another name; the 2026-08-03
  // incident died on "You've hit your session limit" and classified as a plain
  // worker_error, which is why nothing knew the task became resumable later.
  if (
    /\b(?:rate.?limit|too many requests|session limit|usage limit(?: reached)?)\b|statusCode["': ]+429/i
      .test(value)
  ) return "rate_limit";
  if (/\b(?:permission denied|operation not permitted|sandbox)\b/i.test(value)) return "permission_denied";
  return "worker_error";
}

function completionCode(value: string | undefined): CompletionCode {
  return value === "permission_denied" || value === "needs_authority" || value === "worker_error"
    ? value
    : "worker_error";
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
