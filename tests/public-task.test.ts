import { describe, expect, test } from "bun:test";
import { publicTask, publicTaskSummary } from "../src/public-task";
import type { Task, TaskSummary } from "../src/types";

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
