import { describe, expect, test } from "bun:test";
import { publicTask, publicTaskSummary, waitTaskView } from "../src/public-task";
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
  test("never echoes the prompt back to the caller who wrote it", () => {
    const view = waitTaskView(pollingTask());

    // wait gets polled repeatedly; repeating a 4k prompt each time is pure cost.
    expect(view).not.toHaveProperty("prompt");
    expect(view).not.toHaveProperty("shippedPrompt");
    expect(view.promptPreview.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(view).length).toBeLessThan(1_000);
  });

  test("withholds output while running and delivers it once settled", () => {
    expect(waitTaskView(pollingTask({ state: "running", output: "half done" })).output)
      .toBeUndefined();

    for (const state of ["completed", "failed", "cancelled", "blocked", "needs_input"] as const) {
      expect(waitTaskView(pollingTask({ state, output: "the answer" })).output).toBe("the answer");
    }
  });

  test("carries spend, grant and attempt count without the attempt bodies", () => {
    const view = waitTaskView(pollingTask({
      state: "completed",
      output: "done",
      costUsd: 1.64,
      turns: 21,
      grantId: "grant-1",
      attempts: [{ output: "first try", endedAt: new Date().toISOString() }],
    }));

    expect(view).toMatchObject({ costUsd: 1.64, turns: 21, grantId: "grant-1", attemptCount: 1 });
    expect(view).not.toHaveProperty("attempts");
  });

  test("keeps the provider session private while inspect keeps the full text", () => {
    expect(waitTaskView(pollingTask())).not.toHaveProperty("sessionId");
    expect(publicTask(pollingTask()).shippedPrompt).toBeDefined();
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

    expect(publicTask(task)).toMatchObject({ id: "inter-task" });
    expect(publicTask(task)).not.toHaveProperty("sessionId");
    expect(publicTaskSummary(summary)).not.toHaveProperty("sessionId");
  });
});
