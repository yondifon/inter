import { describe, expect, test } from "bun:test";
import {
  continuationPrompt,
  interpretWorkerOutcome,
  workerPrompt,
} from "../src/task-protocol";
import { needsInputQuestion } from "../src/tasks";

describe("needsInputQuestion", () => {
  test("reads a marker at the start of a line", () => {
    expect(needsInputQuestion("Finished analysis.\nINTER_NEEDS_INPUT: Which config should I use?"))
      .toBe("Which config should I use?");
  });

  test("ignores marker text mentioned in prose or code", () => {
    expect(needsInputQuestion("Document `NEEDS_INPUT: <question>` in the README.\nconst marker = \"NEEDS_INPUT: <question>\";"))
      .toBeUndefined();
    expect(needsInputQuestion("INTER_NEEDS_INPUT: Which config?\nI chose one anyway."))
      .toBeUndefined();
  });
});

describe("worker protocol", () => {
  test("teaches every worker how to complete, block, or ask", () => {
    const prompt = workerPrompt("Do the work.", true);
    expect(prompt).toContain("INTER_RESULT: completed");
    expect(prompt).toContain("INTER_BLOCKED:");
    expect(prompt).toContain("INTER_NEEDS_INPUT:");
  });

  test("does not call a clean exit completed without a completion marker", () => {
    expect(interpretWorkerOutcome(0, "Awaiting permission to write the file.", "")).toMatchObject({
      state: "blocked",
      completion: { blocked: true, code: "permission_denied" },
    });
    expect(interpretWorkerOutcome(0, "Looks done.", "")).toMatchObject({
      state: "blocked",
      completion: { code: "unverified" },
    });
  });

  test("accepts an explicit completion marker and strips it from output", () => {
    expect(interpretWorkerOutcome(0, "Done.\nINTER_RESULT: completed", "")).toMatchObject({
      state: "completed",
      output: "Done.",
      completion: { blocked: false, code: "completed" },
    });
  });

  test("classifies provider billing failures", () => {
    expect(interpretWorkerOutcome(1, "", "Insufficient balance. statusCode: 401, type: CreditsError"))
      .toMatchObject({ state: "failed", completion: { code: "billing" } });
  });

  test("makes the resolved answer explicitly supersede conflicts", () => {
    const prompt = continuationPrompt(
      "Do not modify any file.",
      "Should I write it?",
      "Yes, write docs/result.md.",
    );
    expect(prompt).toContain("supersedes any conflicting instruction");
    expect(prompt.indexOf("# Resolved decision")).toBeGreaterThan(prompt.indexOf("# Original task"));
    expect(prompt).toContain("Do not ask the same question again");
  });
});
