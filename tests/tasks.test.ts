import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  continuationPrompt,
  interpretWorkerOutcome,
  rateLimitResetAt,
  workerPrompt,
} from "../src/task-protocol";
import {
  antigravityBootstrapRetryReason,
  compactPayload,
  delegate,
  getTask,
  needsInputQuestion,
  recordProfileTaskOutcome,
} from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile, Task } from "../src/types";

// A custom command means delegate exercises real scope resolution without
// needing a provider CLI on the machine; the worker exits immediately.
const noopProfile: Profile = {
  id: "noop",
  label: "Noop",
  provider: "antigravity",
  model: "fake",
  enabled: true,
  env: {},
  capabilities: [],
  command: ["true"],
};

// delegate() launches the worker without awaiting it. A test that returns
// before the run settles leaves `runTask` calling stateStore() after afterEach
// has closed the store and cleared INTER_DB — which reopens, and migrates, the
// real broker database.
async function settled(id: string): Promise<Task> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = getTask(id);
    if (task && !["queued", "running"].includes(task.state)) return task;
    await Bun.sleep(25);
  }
  throw new Error(`task never settled: ${id}`);
}

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

  test("names the profiles a caller could have used", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-grants-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([
      { ...noopProfile, id: "live" },
      { ...noopProfile, id: "retired", enabled: false },
    ]);

    // A dead end should say where the live options are.
    await expect(delegate("typo", "x", root))
      .rejects.toThrow("unknown profile: typo — enabled profiles are live");
  });

  test("reuses a cwd's stated scope instead of falling back to the whole tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-grants-"));
    const other = mkdtempSync(join(tmpdir(), "inter-grants-"));
    scratch.push(root, other);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = `${root}:${other}`;
    stateStore().saveProfiles([noopProfile]);
    const scope = { read: ["src/**"], write: [] };

    const stated = await delegate(noopProfile.id, "first", root, undefined, undefined, { scope });
    expect(stated.scope).toEqual(scope);
    expect(stated.grantId).toBeString();
    await settled(stated.id);

    // The whole point: omitting scope now inherits what was already approved
    // here rather than silently widening to the entire working tree.
    const inherited = await delegate(noopProfile.id, "second", root);
    expect(inherited.scope).toEqual(scope);
    expect(inherited.grantId).toBe(stated.grantId!);
    await settled(inherited.id);

    // A cwd nobody has approved still falls back, and is flagged for it.
    const ungranted = await delegate(noopProfile.id, "third", other);
    expect(ungranted.scope).toEqual({ read: ["**"], write: ["**"] });
    expect(ungranted.grantId).toBeUndefined();
    expect(stateStore().listTaskEvents(ungranted.id).map(({ type }) => type))
      .toContain("scope_ungranted");
    await settled(ungranted.id);
  });

  test("adds prompt-named paths a stated read scope forgot", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-grants-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([noopProfile]);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "notes.md"), "n");

    // The prompt names notes.md but the stated scope covers only docs/**.
    const task = await delegate(noopProfile.id, "review notes.md against docs/", root, undefined, undefined, {
      scope: { read: ["docs/**"], write: [] },
    });
    expect(task.scope.read).toContain("notes.md");
    expect(task.scope.read).toContain("docs/**");
    const completed = stateStore().listTaskEvents(task.id)
      .find(({ type }) => type === "scope_auto_completed");
    expect(completed?.payload.added).toEqual(["notes.md"]);
    await settled(task.id);

    // Nothing to add when the stated scope already covers the prompt's paths.
    const covered = await delegate(noopProfile.id, "review notes.md", root, undefined, undefined, {
      scope: { read: ["**"], write: [] },
    });
    expect(covered.scope.read).toEqual(["**"]);
    expect(stateStore().listTaskEvents(covered.id).map(({ type }) => type))
      .not.toContain("scope_auto_completed");
    await settled(covered.id);
  });

  test("threads a caller tldr through delegate and leaves it absent when omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-tldr-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([noopProfile]);

    const withTldr = await delegate(noopProfile.id, "prompt", root, undefined, undefined, {
      tldr: "Add dark mode and run the tests",
    });
    expect(withTldr.tldr).toBe("Add dark mode and run the tests");
    await settled(withTldr.id);

    const withoutTldr = await delegate(noopProfile.id, "prompt", root);
    expect(withoutTldr.tldr).toBeUndefined();
    await settled(withoutTldr.id);
  });

  test("records how the destination was decided, against the row that ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-selection-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([noopProfile]);

    const task = await delegate(noopProfile.id, "prompt", root, undefined, undefined, {
      effort: "max",
      selection: {
        decidedBy: "caller-explicit",
        routerVersion: 2,
        difficulty: "hard",
        difficultySource: "caller",
        heuristicClass: "build",
        heuristicAgreed: false,
        floor: 4,
        floorRelaxed: false,
        preference: "balanced",
        effortSource: "caller",
        effortReason: "the caller set it",
        quotaUsedPercent: null,
        warnings: ["noop is unavailable: observed billing failure. Dispatching anyway."],
      },
    });
    await settled(task.id);

    const recorded = stateStore().taskSelection(task.id);
    expect(recorded?.decidedBy).toBe("caller-explicit");
    expect(recorded?.difficulty).toBe("hard");
    expect(recorded?.warnings).toHaveLength(1);
    // The chosen pair comes off the row, so the record cannot claim a profile,
    // model, or effort the task did not actually run with.
    expect(recorded?.chosen).toEqual({
      profileId: noopProfile.id,
      model: noopProfile.model,
      effort: "max",
    });

    const undecided = await delegate(noopProfile.id, "prompt", root);
    await settled(undecided.id);
    expect(stateStore().taskSelection(undecided.id)).toBeUndefined();
  });

  test("threads a caller title through delegate and leaves it absent when omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-title-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    stateStore().saveProfiles([noopProfile]);

    const withTitle = await delegate(noopProfile.id, "prompt", root, undefined, undefined, {
      title: "Add dark mode",
    });
    expect(withTitle.title).toBe("Add dark mode");
    await settled(withTitle.id);

    const withoutTitle = await delegate(noopProfile.id, "prompt", root);
    expect(withoutTitle.title).toBeUndefined();
    await settled(withoutTitle.id);
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

  test("reads a session limit as the rate limit it is, with its reset time", () => {
    // The 2026-08-03 incident, verbatim. It used to classify as worker_error,
    // so nothing recorded that the task became resumable an hour later.
    const outcome = interpretWorkerOutcome(
      1,
      "",
      "You've hit your session limit · resets 12:40am (Africa/Douala)",
    );
    expect(outcome.completion.code).toBe("rate_limit");
    expect(Date.parse(outcome.completion.resetsAt!)).toBeGreaterThan(Date.now());
  });

  test("leaves resetsAt off failures that are not rate limits", () => {
    expect(interpretWorkerOutcome(1, "", "worker crashed").completion.resetsAt).toBeUndefined();
  });
});

describe("rate limit reset times", () => {
  const now = new Date("2026-08-03T20:00:00.000Z");

  test("resolves a wall clock in the zone the provider printed it in", () => {
    // Africa/Douala is UTC+1 year round: 12:40am on the 4th local is 23:40Z on
    // the 3rd — the next occurrence, not one that already passed today.
    expect(rateLimitResetAt("You've hit your session limit · resets 12:40am (Africa/Douala)", now))
      .toBe("2026-08-03T23:40:00.000Z");
    // Same clock time, a zone eight hours behind: a different instant.
    expect(rateLimitResetAt("resets 12:40am (America/Los_Angeles)", now))
      .toBe("2026-08-04T07:40:00.000Z");
  });

  test("reads a countdown and an epoch stamp", () => {
    expect(rateLimitResetAt("Rate limit: five hour · allowed · resets in 48m 15s", now))
      .toBe("2026-08-03T20:48:15.000Z");
    expect(rateLimitResetAt("resets in 2h 5m", now)).toBe("2026-08-03T22:05:00.000Z");
    // Claude Code prints the window as an epoch on the message itself.
    expect(rateLimitResetAt("Claude AI usage limit reached|1754308800", now))
      .toBe(new Date(1_754_308_800_000).toISOString());
  });

  test("returns nothing rather than guessing", () => {
    expect(rateLimitResetAt("You've hit your session limit", now)).toBeUndefined();
    expect(rateLimitResetAt("resets 25:99", now)).toBeUndefined();
    expect(rateLimitResetAt("", now)).toBeUndefined();
    // An unknown zone name falls back to the broker's own clock instead of
    // dropping a time the provider did state.
    expect(rateLimitResetAt("resets 12:40am (Middle/Earth)", now)).toBeString();
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

  test("attributes a rate limit to the model, and a credential failure to the account", () => {
    const recorded: Array<string | undefined> = [];
    const store = {
      clearProfileFailure: () => {},
      recordProfileFailure: (
        _profileId: string,
        _code: string,
        _message: string,
        _retryAt?: string,
        model?: string,
      ) => recorded.push(model),
    };
    recordProfileTaskOutcome(
      store,
      "claude-work",
      interpretWorkerOutcome(1, "", "statusCode: 429 Too many requests"),
      "fable",
    );
    recordProfileTaskOutcome(
      store,
      "claude-work",
      interpretWorkerOutcome(1, "", "statusCode: 401 invalid api key"),
      "fable",
    );
    expect(recorded).toEqual(["fable", undefined]);
  });
});

describe("Antigravity bootstrap retry", () => {
  const networkFailure = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      error: "Eligibility check failed: failed to get profile picture: dial tcp: connect: no route to host",
      num_turns: 0,
    },
  });

  test("retries only bounded zero-turn profile-picture network failures", () => {
    expect(antigravityBootstrapRetryReason("antigravity", 0, undefined, 1, networkFailure))
      .toContain("Eligibility check failed");
    expect(antigravityBootstrapRetryReason("antigravity", 1, undefined, 1, networkFailure))
      .toContain("Eligibility check failed");
    expect(antigravityBootstrapRetryReason("antigravity", 2, undefined, 1, networkFailure))
      .toBeUndefined();
  });

  test("does not retry after a session, a turn, or a non-network failure", () => {
    expect(antigravityBootstrapRetryReason("antigravity", 0, "session-1", 1, networkFailure))
      .toBeUndefined();
    expect(antigravityBootstrapRetryReason("opencode", 0, undefined, 1, networkFailure))
      .toBeUndefined();
    expect(antigravityBootstrapRetryReason(
      "antigravity",
      0,
      undefined,
      1,
      networkFailure.replace('"num_turns":0', '"num_turns":1'),
    )).toBeUndefined();
    expect(antigravityBootstrapRetryReason(
      "antigravity",
      0,
      undefined,
      1,
      networkFailure.replace("no route to host", "not logged in"),
    )).toBeUndefined();
    expect(antigravityBootstrapRetryReason("antigravity", 0, undefined, 2, networkFailure))
      .toBeUndefined();
    expect(antigravityBootstrapRetryReason(
      "antigravity",
      0,
      undefined,
      1,
      networkFailure.replace('"conversation_id":""', '"missing_conversation_id":""'),
    )).toBeUndefined();
  });
});

describe("compactPayload", () => {
  test("drops the running copy pi repeats inside every streamed delta", () => {
    // Measured on a real run: keeping these made one 9-second task cost 827 KB,
    // 91% of it the same message written out again per token.
    const delta = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "world",
        partial: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
      },
      message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
    };
    expect(compactPayload(delta)).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
    });
  });

  test("leaves every other event untouched", () => {
    // message_end is where the assembled reply legitimately lives.
    const end = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
    };
    expect(compactPayload(end)).toEqual(end);
    const tool = { type: "tool_execution_start", toolName: "write", args: { path: "a.ts" } };
    expect(compactPayload(tool)).toEqual(tool);
  });
});
