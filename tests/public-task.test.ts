import { describe, expect, test } from "bun:test";
import { publicTaskSummary, taskView, TASK_FIELD_GROUPS, waitEventsView, waitTaskView } from "../src/public-task";
import { runCostFrom } from "../src/tasks";
import type { Task, TaskSummary } from "../src/types";

function pollingTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    profileId: "claude-work",
    model: "opus",
    prompt: "x".repeat(4_000),
    shippedPrompt: "y".repeat(4_500),
    cwd: "/tmp/project",
    state: "running",
    output: "",
    scope: { read: ["src/**"], write: [] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
    sessionId: "provider-session",
    ...overrides,
  };
}

describe("wait payload", () => {
  // The floor, pinned the same way taskView(task, []) is: wait is the one tool
  // called in a loop, so anything that does not move between two calls has to
  // be asked for. Widening this set is a contract change, not a tidy-up.
  test("the default is the moving half of the task and nothing else", () => {
    const view = waitTaskView(pollingTask({
      title: "Add dark mode",
      tldr: "Add dark mode and run the tests",
      grantId: "grant-1",
      parentTaskId: "task-0",
    }));

    expect(Object.keys(view).sort()).toEqual(["id", "state", "updatedAt"]);
  });

  test("adds only what moved, when it is there to report", () => {
    const view = waitTaskView(pollingTask({
      state: "needs_input",
      question: "Which database?",
      error: "the first attempt timed out",
      completion: { code: "unverified", blocked: false },
      costUsd: 1.64,
      turns: 21,
    }));

    expect(Object.keys(view).sort()).toEqual([
      "completion", "costUsd", "error", "id", "question", "state", "turns", "updatedAt",
    ]);
  });

  test("never echoes back what the caller wrote, at any state", () => {
    for (const state of ["running", "completed", "failed", "cancelled", "blocked", "needs_input"] as const) {
      const view = waitTaskView(pollingTask({ state, output: "the answer" }));
      expect(view).not.toHaveProperty("prompt");
      expect(view).not.toHaveProperty("shippedPrompt");
      // Output used to ride every settled task. One real wait response came back
      // at 276,560 characters because of it; `fields: ["output"]` asks for it.
      expect(view).not.toHaveProperty("output");
      expect(JSON.stringify(view).length).toBeLessThan(300);
    }
  });

  test("fields replaces the default, the way it does on every other tool", () => {
    expect(waitTaskView(pollingTask({ state: "completed", output: "the answer" }), ["output"]))
      .toEqual({ id: "task-1", state: "completed", output: "the answer" });
    expect(waitTaskView(pollingTask(), ["routing"]))
      .toEqual({ id: "task-1", state: "running", profileId: "claude-work", model: "opus" });
  });

  test("attempt count still rides the floor without the attempt bodies", () => {
    const view = waitTaskView(pollingTask({
      attempts: [{ output: "first try", endedAt: new Date().toISOString() }],
    }));

    expect(view).toMatchObject({ attemptCount: 1 });
    expect(view).not.toHaveProperty("attempts");
  });

  test("keeps the provider session private while inspect keeps the full text", () => {
    expect(waitTaskView(pollingTask())).not.toHaveProperty("sessionId");
    expect(taskView(pollingTask(), ["shippedPrompt"]).shippedPrompt).toBeDefined();
  });
});

describe("wait events", () => {
  const rows = [
    { id: 1, taskId: "task-1", type: "agent.tool", state: "running" as const, at: "t1", summary: "Read src/store.ts" },
    { id: 2, taskId: "task-2", type: "agent.tool", state: "running" as const, at: "t2", summary: "Edit src/cli.ts" },
    { id: 3, taskId: "task-1", type: "completed", state: "completed" as const, at: "t3", summary: "Done" },
  ];

  test("hoists the association onto the group instead of stamping every row", () => {
    const groups = waitEventsView(rows);

    expect(groups).toEqual([
      {
        taskId: "task-1",
        events: [
          { id: 1, type: "agent.tool", at: "t1", summary: "Read src/store.ts" },
          { id: 3, type: "completed", at: "t3", summary: "Done" },
        ],
      },
      {
        taskId: "task-2",
        events: [{ id: 2, type: "agent.tool", at: "t2", summary: "Edit src/cli.ts" }],
      },
    ]);
    // The state a row was written in is the task's, and the task carries it.
    for (const group of groups) for (const event of group.events) {
      expect(event).not.toHaveProperty("state");
      expect(event).not.toHaveProperty("taskId");
    }
  });

  test("a summary stays a trace line, not a transcript", () => {
    const [group] = waitEventsView([{ ...rows[0]!, summary: `thinking\n${"a".repeat(500)}` }]);

    expect(group!.events[0]!.summary).toBe(`thinking ${"a".repeat(151)}`);
  });
});

describe("taskView", () => {
  const now = new Date().toISOString();
  const full = pollingTask({
    state: "completed",
    output: "the result",
    error: "something went wrong",
    question: "which file?",
    parentTaskId: "parent-1",
    grantId: "grant-1",
    timeoutMs: 60_000,
    effort: "xhigh",
    effortActual: "high",
    tldr: "Add dark mode",
    title: "Dark mode",
    completion: { blocked: false, code: "completed" },
    attempts: [{ output: "first", endedAt: now }],
    costUsd: 1.64,
    turns: 21,
    archivedAt: now,
  });

  test("core is always present", () => {
    const view = taskView(full, []);
    expect(view).toHaveProperty("id");
    expect(view).toHaveProperty("state");
    expect(view).toHaveProperty("attemptCount", 1);
    expect(view).toHaveProperty("archivedAt");
    expect(view).not.toHaveProperty("sessionId");
    expect(view).not.toHaveProperty("updatedAt");
  });

  test("attemptCount absent when there are no attempts", () => {
    const view = taskView(pollingTask(), []);
    expect(view).not.toHaveProperty("attemptCount");
  });

  test("empty fields includes none of the heavy or payload fields", () => {
    const view = taskView(full, []);
    expect(Object.keys(view).sort()).toEqual([
      "archivedAt", "attemptCount", "id", "state",
    ]);
  });

  test("floor is exactly {id, state} when a task has no attempts and no archivedAt", () => {
    const lean = pollingTask({});
    const view = taskView(lean, []);
    expect(Object.keys(view).sort()).toEqual(["id", "state"]);
  });

  test("routing group adds its own fields and nothing else", () => {
    const view = taskView(full, ["routing"]);
    expect(view).toHaveProperty("profileId", full.profileId);
    expect(view).toHaveProperty("model", full.model);
    expect(view).toHaveProperty("effort", full.effort);
    expect(view).toHaveProperty("effortActual", full.effortActual);
    expect(view).not.toHaveProperty("cwd");
    expect(view).not.toHaveProperty("createdAt");
    expect(view).not.toHaveProperty("title");
    expect(view).not.toHaveProperty("prompt");
    expect(view).not.toHaveProperty("output");
  });

  test("effort stays absent when the task has none", () => {
    const view = taskView(pollingTask(), ["routing"]);
    expect(view).not.toHaveProperty("effort");
  });

  test("scope group adds its own fields and nothing else", () => {
    const view = taskView(full, ["scope"]);
    expect(view).toHaveProperty("scope");
    expect(view).toHaveProperty("grantId", full.grantId);
    expect(view).toHaveProperty("allowQuestions");
    expect(view).toHaveProperty("timeoutMs", full.timeoutMs);
    expect(view).not.toHaveProperty("prompt");
    expect(view).not.toHaveProperty("output");
  });

  test("completion group adds its own fields and nothing else", () => {
    const view = taskView(full, ["completion"]);
    expect(view).toHaveProperty("completion");
    expect(view).toHaveProperty("error", full.error);
    expect(view).toHaveProperty("question", full.question);
    expect(view).not.toHaveProperty("prompt");
    expect(view).not.toHaveProperty("output");
  });

  test("spend group adds its own fields and nothing else", () => {
    const view = taskView(full, ["spend"]);
    expect(view).toHaveProperty("costUsd", full.costUsd);
    expect(view).toHaveProperty("turns", full.turns);
    expect(view).not.toHaveProperty("prompt");
  });

  test("costUsd and turns stay absent when the task has none", () => {
    const view = taskView(pollingTask(), ["spend"]);
    expect(view).not.toHaveProperty("costUsd");
    expect(view).not.toHaveProperty("turns");
  });

  test("fields replace the default, they do not extend it", () => {
    const view = taskView(full, ["output"]);
    expect(view).toHaveProperty("output", full.output);
    expect(view).not.toHaveProperty("prompt");
    expect(view).not.toHaveProperty("shippedPrompt");
    expect(view).not.toHaveProperty("profileId");
  });

  test('"all" includes prompt, shippedPrompt, output and attempts, omits sessionId', () => {
    const view = taskView(full, ["all"]);
    expect(view).toHaveProperty("prompt", full.prompt);
    expect(view).toHaveProperty("shippedPrompt", full.shippedPrompt);
    expect(view).toHaveProperty("output", full.output);
    expect(view).toHaveProperty("attempts");
    expect(view).not.toHaveProperty("sessionId");
  });

  test("inspect default includes output and scope but omits prompt, shippedPrompt and attempts", () => {
    const inspectGroups = Object.keys(TASK_FIELD_GROUPS).filter(
      (k) => k !== "prompt" && k !== "shippedPrompt" && k !== "attempts",
    );
    const view = taskView(full, inspectGroups as Parameters<typeof taskView>[1]);
    expect(view).not.toHaveProperty("prompt");
    expect(view).toHaveProperty("output", full.output);
    expect(view).not.toHaveProperty("shippedPrompt");
    expect(view).not.toHaveProperty("attempts");
  });

  test("absent optional fields stay absent rather than appearing as undefined", () => {
    const lean = pollingTask({});
    const view = taskView(lean, ["all"]);
    expect(view).not.toHaveProperty("error");
    expect(view).not.toHaveProperty("question");
    expect(view).not.toHaveProperty("completion");
    expect(view).not.toHaveProperty("costUsd");
    expect(view).not.toHaveProperty("turns");
    expect(view).not.toHaveProperty("effort");
    expect(view).not.toHaveProperty("tldr");
    expect(view).not.toHaveProperty("title");
    expect(view).not.toHaveProperty("parentTaskId");
    expect(view).not.toHaveProperty("grantId");
    expect(view).not.toHaveProperty("timeoutMs");
    expect(view).not.toHaveProperty("archivedAt");
    expect(view).not.toHaveProperty("attemptCount");
    expect(view).not.toHaveProperty("sessionId");
  });

  test("never emits sessionId under any fields value including all", () => {
    for (const fields of [["routing"] as const, ["all"] as const, [] as const]) {
      expect(taskView(full, fields)).not.toHaveProperty("sessionId");
    }
  });

  test("keeps a prior run's profile on its attempt and its session off the wire", () => {
    // Handoff stores the dead run's session on the attempt so the row remembers
    // which account holds that work. It is still a provider session id.
    const moved = pollingTask({
      profileId: "default",
      attempts: [{
        output: "partial findings",
        endedAt: new Date().toISOString(),
        profileId: "claude-work",
        sessionId: "provider-session",
        completion: { blocked: true, code: "rate_limit" },
      }],
    });
    const attempts = taskView(moved, ["attempts"]).attempts ?? [];
    expect(attempts[0]).toHaveProperty("profileId", "claude-work");
    expect(attempts[0]).not.toHaveProperty("sessionId");
    expect(JSON.stringify(taskView(moved, ["all"]))).not.toContain("provider-session");
  });
});

describe("run cost", () => {
  test("reads spend from either shape providers report it in", () => {
    expect(runCostFrom({ type: "result", total_cost_usd: 1.64, num_turns: 21 }))
      .toEqual({ costUsd: 1.64, turns: 21 });
    expect(runCostFrom({ event: "result", result: { num_turns: 4, total_cost_usd: 0.2 } }))
      .toEqual({ costUsd: 0.2, turns: 4 });
  });

  test("reports nothing for events that carry no spend", () => {
    expect(runCostFrom({ type: "assistant", text: "working" })).toEqual({});
    expect(runCostFrom({ type: "result", total_cost_usd: Number.NaN })).toEqual({});
  });
});

describe("public task contract", () => {
  test("exposes the Inter task id but not the provider session id", () => {
    const task = {
      id: "inter-task",
      profileId: "opencode",
      model: "provider/model",
      prompt: "work",
      cwd: "/repo",
      state: "running",
      output: "",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      scope: { read: [], write: [] },
      allowQuestions: true,
      sessionId: "provider-session",
    } satisfies Task;
    const summary = {
      id: task.id,
      profileId: task.profileId,
      model: task.model,
      cwd: task.cwd,
      state: task.state,
      promptPreview: task.prompt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sessionId: task.sessionId,
    } satisfies TaskSummary;

    expect(taskView(task, ["all"])).toMatchObject({ id: "inter-task" });
    expect(taskView(task, ["all"])).not.toHaveProperty("sessionId");
    expect(publicTaskSummary(summary)).not.toHaveProperty("sessionId");
  });
});
