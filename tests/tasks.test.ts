import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  continuationPrompt,
  interpretWorkerOutcome,
  workerPrompt,
} from "../src/task-protocol";
import { delegate, needsInputQuestion, recordProfileTaskOutcome } from "../src/tasks";
import { closeStateStore } from "../src/store";

describe("delegate workspace roots", () => {
  const savedRoots = process.env.INTER_ROOTS;
  const savedDb = process.env.INTER_DB;
  const scratch: string[] = [];

  afterEach(() => {
    closeStateStore();
    if (savedRoots === undefined) delete process.env.INTER_ROOTS;
    else process.env.INTER_ROOTS = savedRoots;
    if (savedDb === undefined) delete process.env.INTER_DB;
    else process.env.INTER_DB = savedDb;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("defaults INTER_ROOTS to the home directory, not the broker cwd", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "inter-roots-"));
    scratch.push(dbDir);
    process.env.INTER_DB = join(dbDir, "inter.db");
    delete process.env.INTER_ROOTS;
    // tmpdir lives outside home: still fenced out.
    await expect(delegate("missing-profile", "x", dbDir))
      .rejects.toThrow("cwd is outside INTER_ROOTS");
    // Any path under home passes the fence and reaches profile resolution,
    // even though the broker process cwd is a single project.
    await expect(delegate("missing-profile", "x", homedir()))
      .rejects.toThrow("unknown profile: missing-profile");
  });
});

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

  test("tells the worker its enforced file scope", () => {
    const prompt = workerPrompt("Do.", true, { read: ["src/**"], write: ["src/api.ts"] });
    expect(prompt).toContain("src/**, src/api.ts");
    expect(prompt).toContain("writable: src/api.ts");
    expect(prompt).toContain("operation not permitted");
    expect(workerPrompt("Do.", true, { read: ["**"], write: [] }))
      .toContain("writable: nothing");
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
    expect(interpretWorkerOutcome(0, "Done.\nINTER_RESULT: completed\n", "")).toMatchObject({
      state: "completed",
      output: "Done.",
      completion: { blocked: false, code: "completed" },
    });
  });

  test("accepts a completion marker followed by trailing prose", () => {
    expect(interpretWorkerOutcome(0, "INTER_RESULT: completed\nSummary: wrote 3 files.", ""))
      .toMatchObject({
        state: "completed",
        output: "Summary: wrote 3 files.",
        completion: { blocked: false, code: "completed" },
      });
  });

  test("ignores an instruction echo of the completion marker", () => {
    expect(interpretWorkerOutcome(0, "I will end with: INTER_RESULT: completed once done.", ""))
      .toMatchObject({ state: "blocked", completion: { code: "unverified" } });
  });

  test("treats a trailing prose question as needs_input", () => {
    expect(interpretWorkerOutcome(0, "I stopped before writing.\nShould I overwrite config.json?", ""))
      .toMatchObject({
        state: "needs_input",
        question: "Should I overwrite config.json?",
        completion: { blocked: true, code: "needs_authority", reason: "Should I overwrite config.json?" },
      });
    // A question phrased with permission language is still an ask, not a wall.
    expect(interpretWorkerOutcome(0, "I need your approval first. Proceed with the rewrite?", ""))
      .toMatchObject({ state: "needs_input", question: "I need your approval first. Proceed with the rewrite?" });
  });

  test("finds the ask when the question is decorated or not the last line", () => {
    // Verbatim shape from a live haiku worker that previously landed unverified.
    const fielded = [
      "Tell me which language you'd like it in.",
      "",
      "**What is your preferred language for the greeting?**",
      "",
      "(I'll write the two-sentence greeting to `askme3/greeting.txt` once you let me know.)",
    ].join("\n");
    expect(interpretWorkerOutcome(0, fielded, "")).toMatchObject({
      state: "needs_input",
      question: "What is your preferred language for the greeting?",
    });
    expect(interpretWorkerOutcome(0, "Should I proceed with the rewrite?\n1. Yes\n2. No", ""))
      .toMatchObject({ state: "needs_input", question: "Should I proceed with the rewrite?" });
  });

  test("accepts protocol markers followed by empty lines", () => {
    expect(needsInputQuestion("INTER_NEEDS_INPUT: Which config?\n\n")).toBe("Which config?");
    expect(interpretWorkerOutcome(0, "INTER_BLOCKED: needs_authority | Missing config\n\n", ""))
      .toMatchObject({
        state: "blocked",
        completion: { code: "needs_authority", reason: "Missing config" },
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

describe("profile outcome recording", () => {
  test("clears observed failures only after successful generation", () => {
    const calls: string[] = [];
    const store = {
      clearProfileFailure: (profileId: string) => calls.push(`clear:${profileId}`),
      recordProfileFailure: () => calls.push("record"),
    };
    recordProfileTaskOutcome(
      store,
      "claude-work",
      interpretWorkerOutcome(0, "Done.\nINTER_RESULT: completed", ""),
    );
    expect(calls).toEqual(["clear:claude-work"]);
  });

  test("records auth, billing, and rate-limit failures", () => {
    const calls: string[] = [];
    const store = {
      clearProfileFailure: () => calls.push("clear"),
      recordProfileFailure: (_profileId: string, code: string) => calls.push(code),
    };
    recordProfileTaskOutcome(
      store,
      "claude-work",
      interpretWorkerOutcome(1, "", "statusCode: 429 Too many requests"),
    );
    expect(calls).toEqual(["rate_limit"]);
  });
});
