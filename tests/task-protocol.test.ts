import { describe, expect, test } from "bun:test";
import { interpretWorkerOutcome, needsInputQuestion } from "../src/task-protocol";

const done = (output: string) => interpretWorkerOutcome(0, output, "");

describe("completion marker", () => {
  // Every one of these was observed as blocked/unverified before the marker
  // accepted decoration. The worker had finished; it just signed off in
  // markdown, which the smaller models do by default.
  const decorated: Array<[string, string]> = [
    ["plain", "Done.\n\nINTER_RESULT: completed"],
    ["bold", "Done.\n\n**INTER_RESULT: completed**"],
    ["inline code", "Done.\n\n`INTER_RESULT: completed`"],
    ["fenced", "Done.\n\n```\nINTER_RESULT: completed\n```"],
    ["trailing period", "Done.\n\nINTER_RESULT: completed."],
    ["bold and period", "Done.\n\n**INTER_RESULT: completed.**"],
    ["bullet", "Done.\n\n- INTER_RESULT: completed"],
    ["bold bullet", "Done.\n\n- **INTER_RESULT: completed**"],
    ["block quote", "Done.\n\n> INTER_RESULT: completed"],
    ["heading", "Done.\n\n## INTER_RESULT: completed"],
    ["indented", "Done.\n\n    INTER_RESULT: completed"],
  ];

  for (const [label, output] of decorated) {
    test(`accepts a ${label} marker`, () => {
      expect(done(output).state).toBe("completed");
    });
  }

  test("still refuses to invent a completion when no marker is present", () => {
    const outcome = done("I finished the refactor and all tests pass.");
    expect(outcome.state).toBe("blocked");
    expect(outcome.completion.code).toBe("unverified");
  });

  test("does not fire on the instruction echoing the marker mid-sentence", () => {
    // The shipped prompt contains this sentence, and workers quote it back.
    const outcome = done("The contract says to end with: INTER_RESULT: completed when done.");
    expect(outcome.state).toBe("blocked");
  });
});

describe("blocked marker", () => {
  test("accepts decoration around the marker", () => {
    const outcome = done("**INTER_BLOCKED: permission_denied | cannot write there**");
    expect(outcome.state).toBe("blocked");
    expect(outcome.completion.code).toBe("permission_denied");
  });

  test("keeps a glob intact in the reason", () => {
    const outcome = done("INTER_BLOCKED: permission_denied | write denied on docs/**");
    expect(outcome.completion.reason).toBe("write denied on docs/**");
  });
});

describe("needs-input marker", () => {
  test("accepts a bolded question and strips the closing bold", () => {
    const output = "**INTER_NEEDS_INPUT: Which database should I target?**";
    expect(needsInputQuestion(output)).toBe("Which database should I target?");
    expect(done(output).state).toBe("needs_input");
  });

  test("accepts a bulleted question", () => {
    expect(done("- INTER_NEEDS_INPUT: Which one?").state).toBe("needs_input");
  });
});
