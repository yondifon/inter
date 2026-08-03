import { describe, expect, test } from "bun:test";
import { DIGEST_CAP, handoffBrief, VERBATIM_CAP } from "../src/handoff-brief";
import type { TaskEvent } from "../src/store";
import type { Task } from "../src/types";

const PROMPT = "# Goal\nReview src/store.ts and write the findings to docs/reviews/store.md.";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    profileId: "claude-work",
    model: "opus",
    prompt: PROMPT,
    cwd: "/root/project",
    state: "failed",
    output: "",
    error: "You've hit your session limit · resets 12:40am (Africa/Douala)",
    completion: {
      blocked: true,
      code: "rate_limit",
      reason: "You've hit your session limit",
      resetsAt: "2026-08-03T23:40:00.000Z",
    },
    scope: { read: ["**"], write: ["docs/reviews/**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let nextEventId = 1;
function event(payload: Record<string, unknown>, type = "agent.assistant"): TaskEvent {
  return {
    id: nextEventId++,
    taskId: "task-1",
    type,
    state: "running",
    payload,
    createdAt: new Date().toISOString(),
  };
}

function says(text: string): TaskEvent {
  return event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function calls(name: string, input: Record<string, unknown>): TaskEvent {
  return event({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  });
}

describe("handoff brief", () => {
  test("carries the prompt, the failure, the reset time, and the messages verbatim", () => {
    const brief = handoffBrief(task(), [
      calls("Read", { file_path: "/root/project/src/store.ts" }),
      says("The cursor is off by one in listTaskEvents."),
      calls("Write", { file_path: "/root/project/docs/reviews/store.md" }),
      says("Findings written. Two more files to check."),
    ], "claude");

    expect(brief.tier).toBe("verbatim");
    expect(brief.omittedMessages).toBe(0);
    // The prompt is the contract and is never condensed.
    expect(brief.prompt).toContain(PROMPT);
    // Why the previous run ended, in the caller's own vocabulary.
    expect(brief.prompt).toContain("rate_limit");
    expect(brief.prompt).toContain("You've hit your session limit");
    expect(brief.prompt).toContain("2026-08-03T23:40:00.000Z");
    // The previous worker's actual words, not a retelling of them.
    expect(brief.prompt).toContain("The cursor is off by one in listTaskEvents.");
    expect(brief.prompt).toContain("Findings written. Two more files to check.");
    // What it did, and what it left on disk.
    expect(brief.prompt).toContain("Read file: …/project/src/store.ts");
    expect(brief.prompt).toContain("docs/reviews/store.md");
    expect(brief.prompt).toContain("profile `claude-work`");
    expect(brief.prompt).toContain("Continue this task from where the previous run stopped");
  });

  test("condenses only past the cap, and then keeps the tail", () => {
    const filler = "x".repeat(400);
    const events = [
      calls("Read", { file_path: "/root/project/src/store.ts" }),
      ...Array.from({ length: 120 }, (_, index) => says(`turn ${index} ${filler}`)),
      says("FINAL: the off-by-one is in listTaskEvents, the rest of the suite is clean."),
    ];
    const brief = handoffBrief(task(), events, "claude");

    expect(brief.tier).toBe("digest");
    // Conclusions live at the end, so the end is what survives.
    expect(brief.prompt).toContain("FINAL: the off-by-one is in listTaskEvents");
    // The middle is what goes, and it goes on the record.
    expect(brief.prompt).not.toContain("turn 0 ");
    expect(brief.omittedMessages).toBeGreaterThan(0);
    expect(brief.prompt).toContain(`${brief.omittedMessages} earlier messages omitted`);
    // The tool trace survives condensing; it is what stops the next worker
    // re-reading everything.
    expect(brief.prompt).toContain("Read file: …/project/src/store.ts");
    // Everything except the prompt itself stays inside the digest budget.
    expect(brief.chars - PROMPT.length).toBeLessThan(DIGEST_CAP + 2_000);
  });

  test("never condenses the prompt, however large the trace", () => {
    const huge = `${PROMPT}\n${"context line\n".repeat(2_000)}`;
    const brief = handoffBrief(task({ prompt: huge }), [
      ...Array.from({ length: 200 }, (_, index) => says(`turn ${index} ${"y".repeat(400)}`)),
    ], "claude");

    expect(brief.tier).toBe("digest");
    expect(brief.prompt).toContain(huge);
  });

  test("deduplicates the tool trace when condensing", () => {
    const events = [
      ...Array.from({ length: 40 }, () => calls("Read", { file_path: "/root/project/src/store.ts" })),
      ...Array.from({ length: 80 }, (_, index) => says(`turn ${index} ${"z".repeat(400)}`)),
    ];
    const brief = handoffBrief(task(), events, "claude");

    expect(brief.tier).toBe("digest");
    expect(brief.prompt.split("Read file: …/project/src/store.ts")).toHaveLength(2);
  });

  test("rejoins a reply the provider streamed a chunk at a time", () => {
    // pi sends one event per token; splitting them into 3 messages would make
    // the brief unreadable and blow the message budget on fragments.
    const brief = handoffBrief(task(), [
      event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "The bug " } }),
      event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "is in " } }),
      event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "store.ts." } }),
    ], "pi");

    expect(brief.prompt).toContain("[assistant] The bug is in store.ts.");
  });

  test("keeps a trace that fits under the verbatim cap whole", () => {
    const events = Array.from({ length: 20 }, (_, index) => says(`turn ${index} ${"w".repeat(200)}`));
    const brief = handoffBrief(task(), events, "claude");

    expect(brief.tier).toBe("verbatim");
    expect(brief.prompt).toContain("turn 0 ");
    expect(brief.prompt).toContain("turn 19 ");
    expect(brief.chars - PROMPT.length).toBeLessThan(VERBATIM_CAP + 2_000);
  });

  test("says so rather than lying when the run left no trace", () => {
    const brief = handoffBrief(task({ output: "" }), [], "claude");
    expect(brief.prompt).toContain("The previous run produced no readable trace.");
    expect(brief.tier).toBe("verbatim");
  });
});
