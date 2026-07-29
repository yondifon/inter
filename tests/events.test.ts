import { describe, expect, test } from "bun:test";
import { taskEventView } from "../src/events";

describe("task event views", () => {
  test("turns OpenCode tool JSON into a concise file event", () => {
    const view = taskEventView({
      id: 3,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/repo/a.ts" } } },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("file");
    expect(view.title).toBe("Read file");
    expect(view.detail).toBe("/repo/a.ts");
    expect(view.rawText).toContain("tool_use");
  });

  test("turns Codex agent messages into readable events", () => {
    const view = taskEventView({
      id: 4,
      taskId: "task",
      type: "agent.item.completed",
      state: "running",
      payload: { type: "item.completed", item: { type: "agent_message", text: "Done" } },
      createdAt: "now",
    }, "codex");
    expect(view.kind).toBe("message");
    expect(view.detail).toBe("Done");
  });

  test("shows stalled worker heartbeats", () => {
    const view = taskEventView({
      id: 5,
      taskId: "task",
      type: "heartbeat",
      state: "running",
      payload: { elapsedMs: 40_000, silentMs: 35_000, stalled: true },
      createdAt: "now",
    }, "codex");

    expect(view.title).toBe("Heartbeat");
    expect(view.detail).toBe("No agent event for 35s");
    expect(view.rawText).toContain("\"stalled\": true");
  });
});
