import { describe, expect, test } from "bun:test";
import { waitEventsView, waitTaskView } from "../src/public-task";
import type { Task, TaskState } from "../src/types";

/**
 * The fixture the `wait` slimming was measured on, kept as a test so the saving
 * cannot quietly regress: three tasks of the shape Inter really dispatches — a
 * ~4k prompt, a shipped prompt, a title and a tldr — and twenty events each,
 * with the long thinking-block summaries that dominated the real payload.
 *
 * Measured live before this change, one `wait` response came back at 276,560
 * characters and had to be spilled to a file before it could be read.
 */
function fixtureTask(index: number, overrides: Partial<Task> = {}): Task {
  const now = new Date("2026-08-04T12:00:00Z").toISOString();
  return {
    id: `task-${index}`,
    profileId: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    effort: "max",
    prompt: `Refactor the store module. ${"context ".repeat(500)}`,
    shippedPrompt: `Refactor the store module. ${"context ".repeat(560)}`,
    cwd: "/Users/dev/desgn/inter",
    state: "running",
    output: "",
    scope: { read: ["**"], write: ["src/**", "tests/**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
    title: `Refactor the store module (${index})`,
    tldr: "Split the store's schema migrations out of the main module.",
    grantId: "grant-7",
    sessionId: "provider-session",
    ...overrides,
  };
}

function fixtureEvents(taskId: string, state: TaskState) {
  return Array.from({ length: 20 }, (_unused, position) => ({
    id: position + 1,
    taskId,
    type: position % 3 === 0 ? "agent.message" : "agent.tool",
    state,
    at: new Date("2026-08-04T12:00:00Z").toISOString(),
    // waitForTasks caps a summary at 500 characters, and a thinking block or a
    // file read reaches that cap routinely.
    summary: `Read src/store.ts: ${"the migration table is keyed by version ".repeat(20)}`.slice(0, 500),
  }));
}

const tasks = [
  fixtureTask(1, { state: "completed", output: "x".repeat(20_000), costUsd: 1.64, turns: 21 }),
  fixtureTask(2, { state: "needs_input", question: "Which database should the migration target?" }),
  fixtureTask(3, { state: "running" }),
];
const events = tasks.flatMap((task) => fixtureEvents(task.id, task.state));

/** The pre-change shape, kept verbatim so the comparison is against what shipped. */
function legacyWaitTaskView(task: Task) {
  return {
    id: task.id,
    profileId: task.profileId,
    model: task.model,
    cwd: task.cwd,
    state: task.state,
    promptPreview: task.prompt.replace(/\s+/g, " ").trim().slice(0, 240),
    ...(task.tldr ? { tldr: task.tldr } : {}),
    ...(task.title ? { title: task.title } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.question ? { question: task.question } : {}),
    ...(task.grantId ? { grantId: task.grantId } : {}),
    ...(task.completion ? { completion: task.completion } : {}),
    ...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
    ...(task.turns === undefined ? {} : { turns: task.turns }),
    ...(task.output && task.state !== "running" ? { output: task.output } : {}),
  };
}

const before = JSON.stringify({ reason: "attention", cursor: 60, tasks: tasks.map(legacyWaitTaskView), events }, null, 2);
const after = JSON.stringify({
  reason: "attention",
  cursor: 60,
  tasks: tasks.map((task) => waitTaskView(task)),
  events: waitEventsView(events),
}, null, 2);

describe("wait payload size, on a three-task twenty-event fixture", () => {
  test("the slim default is a fraction of what wait used to ship", () => {
    console.log(`wait payload: before ${before.length} chars, after ${after.length} chars`);
    expect(before.length).toBeGreaterThan(50_000);
    expect(after.length).toBeLessThan(before.length / 3);
  });

  test("output no longer rides a settled task by default, and fields brings it back", () => {
    expect(waitTaskView(tasks[0]!)).not.toHaveProperty("output");
    expect(waitTaskView(tasks[0]!, ["output"]).output).toBe("x".repeat(20_000));
  });
});
