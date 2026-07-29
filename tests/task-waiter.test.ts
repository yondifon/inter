import { describe, expect, test } from "bun:test";
import { TaskWaiter } from "../src/task-waiter";
import type { Task } from "../src/types";

function task(id: string, state: Task["state"] = "running"): Task {
  const now = new Date().toISOString();
  return {
    id,
    profileId: "default",
    model: "sonnet",
    prompt: "work",
    cwd: "/tmp/project",
    state,
    output: "",
    createdAt: now,
    updatedAt: now,
  };
}

describe("TaskWaiter", () => {
  test("returns terminal work immediately", async () => {
    const tasks = new Map([["done", task("done", "completed")]]);
    const waiter = new TaskWaiter((id) => tasks.get(id));

    expect(await waiter.wait(["done"], 100)).toEqual({
      reason: "attention",
      tasks: [tasks.get("done")!],
      cursor: 0,
    });
  });

  test("wakes concurrent waiters when one tracked task needs attention", async () => {
    const running = task("work");
    const other = task("other");
    const tasks = new Map([["work", running], ["other", other]]);
    const waiter = new TaskWaiter((id) => tasks.get(id));
    const first = waiter.wait(["work", "other"], 100);
    const second = waiter.wait(["work"], 100);

    waiter.notify("unrelated");
    running.state = "needs_input";
    running.question = "Which config?";
    waiter.notify("work");

    expect((await first).reason).toBe("attention");
    expect((await first).tasks.map(({ id }) => id)).toEqual(["work", "other"]);
    expect((await second).tasks[0]?.question).toBe("Which config?");
  });

  test("returns current snapshots on timeout", async () => {
    const running = task("work");
    const waiter = new TaskWaiter((id) => id === running.id ? running : undefined);

    expect(await waiter.wait(["work"], 1)).toEqual({
      reason: "timeout",
      tasks: [running],
      cursor: 0,
    });
  });

  test("wakes on progress newer than the caller cursor", async () => {
    const running = task("work");
    let cursor = 4;
    const waiter = new TaskWaiter(
      (id) => id === running.id ? running : undefined,
      () => cursor,
    );
    const waiting = waiter.wait(["work"], 100, undefined, cursor);

    cursor = 5;
    waiter.notify("work");

    expect(await waiting).toEqual({
      reason: "progress",
      tasks: [running],
      cursor: 5,
    });
  });

  test("rejects unknown task IDs", async () => {
    const waiter = new TaskWaiter(() => undefined);
    await expect(waiter.wait(["missing"], 100)).rejects.toThrow("unknown task: missing");
  });
});
