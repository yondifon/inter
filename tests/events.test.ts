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

  test("summarizes an OpenCode edit as one changed value", () => {
    const view = taskEventView({
      id: 4,
      taskId: "task",
      type: "agent.tool",
      state: "running",
      payload: {
        part: {
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "examples/inter-test-app/index.html",
            input: {
              filePath: "/repo/examples/inter-test-app/index.html",
              oldString: "<strong id=\"open-work-count\">03</strong>",
              newString: "<strong id=\"open-work-count\">02</strong>",
            },
          },
        },
      },
      createdAt: "now",
    }, "opencode");

    expect(view.kind).toBe("file");
    expect(view.title).toBe("Edit file");
    expect(view.detail).toBe("examples/inter-test-app/index.html · 03 → 02");
    expect(view.presentation).toEqual({
      type: "file",
      path: "examples/inter-test-app/index.html",
      change: "03 → 02",
    });
  });

  test("summarizes a Claude edit hook", () => {
    const view = taskEventView({
      id: 5,
      taskId: "task",
      type: "agent.hook",
      state: "running",
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "/repo/src/app.ts",
          old_string: "const count = 3;",
          new_string: "const count = 2;",
        },
      },
      createdAt: "now",
    }, "claude");

    expect(view.kind).toBe("file");
    expect(view.title).toBe("Edit file");
    expect(view.detail).toBe("/repo/src/app.ts · 3 → 2");
  });

  test("creates a typed Codex command presentation", () => {
    const view = taskEventView({
      id: 7,
      taskId: "task",
      type: "agent.item.completed",
      state: "running",
      payload: {
        item: {
          type: "command_execution",
          command: "bun test",
          status: "completed",
          exit_code: 0,
        },
      },
      createdAt: "now",
    }, "codex");

    expect(view.presentation).toEqual({
      type: "command",
      command: "bun test",
      status: "completed",
      exitCode: 0,
    });
  });

  test("summarizes deleted text without dumping the payload", () => {
    const view = taskEventView({
      id: 6,
      taskId: "task",
      type: "agent.tool",
      state: "running",
      payload: {
        part: {
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: "/repo/app.ts", oldString: "debugger;", newString: "" },
          },
        },
      },
      createdAt: "now",
    }, "opencode");

    expect(view.detail).toBe("/repo/app.ts · debugger; → ∅");
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
