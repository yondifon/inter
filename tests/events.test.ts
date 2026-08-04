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

  test("folds a tool progress ping away from the trace", () => {
    const view = taskEventView({
      id: 12,
      taskId: "task",
      type: "agent.tool_progress",
      state: "running",
      payload: {
        type: "tool_progress",
        tool_use_id: "toolu_a-heartbeat-0",
        tool_name: "Bash",
        heartbeat: true,
        elapsed_time_seconds: 30,
      },
      createdAt: "now",
    }, "claude");

    expect(view.minor).toBe(true);
    expect(view.title).toBe("Tool progress");
    expect(view.detail).toBe("Bash · running 30s");
  });

  test("keeps the todo presentation and a readable name for a tool call", () => {
    const view = taskEventView({
      id: 11,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Read the files", status: "completed" },
                { content: "Fix the palette", status: "in_progress" },
                { content: "Run the tests", status: "pending" },
              ],
            },
          },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("tool");
    expect(view.title).toBe("Todo list");
    expect(view.presentation).toEqual({
      type: "todo",
      completed: 1,
      total: 3,
      text: "Fix the palette",
    });
    expect(view.detail).toBe("1 of 3 complete · Fix the palette");
  });

  test("summarizes a tool with no dedicated layout from its arguments", () => {
    const view = taskEventView({
      id: 12,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "grep",
          state: { status: "completed", input: { pattern: "TaskState", include: "*.swift" } },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.title).toBe("Search code");
    expect(view.presentation).toEqual({ type: "tool", text: "Pattern: TaskState · Include: *.swift" });
  });

  test("falls back to the tool state title when no argument is recognizable", () => {
    const view = taskEventView({
      id: 13,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "mystery_tool",
          state: { status: "completed", title: "Doing   something opaque", input: { weird: 1 } },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.title).toBe("Mystery Tool");
    expect(view.presentation).toEqual({ type: "tool", text: "Doing something opaque" });
  });

  test("turns a Claude result into a run summary with cost, turns, and tokens", () => {
    const view = taskEventView({
      id: 20,
      taskId: "task",
      type: "agent.result",
      state: "completed",
      payload: {
        type: "result", subtype: "success", is_error: false,
        duration_ms: 11311, num_turns: 2, total_cost_usd: 0.1691551,
        usage: {
          input_tokens: 4, cache_creation_input_tokens: 23873,
          cache_read_input_tokens: 71197, output_tokens: 259,
        },
        permission_denials: [],
      },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("usage");
    expect(view.title).toBe("Run summary");
    expect(view.presentation).toMatchObject({
      type: "usage", costUsd: 0.1691551, turns: 2, durationMs: 11311,
      tokensOut: 259, tokensIn: 23877, tokensCached: 71197,
    });
    expect(view.detail).toBe("$0.17 · 2 turns · 11s");
  });

  test("surfaces permission denials on the run summary", () => {
    const view = taskEventView({
      id: 21,
      taskId: "task",
      type: "agent.result",
      state: "completed",
      payload: {
        type: "result",
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "ls" } },
          { tool_name: "Write", tool_input: { file_path: "a.md" } },
          { tool_name: "Bash", tool_input: { command: "pwd" } },
        ],
      },
      createdAt: "now",
    }, "claude");
    expect(view.presentation?.level).toBe("warning");
    expect(view.presentation?.text).toBe("3 permission denials: Bash, Write");
  });

  test("turns Codex turn usage into token counts with cached input split out", () => {
    const view = taskEventView({
      id: 22,
      taskId: "task",
      type: "agent.turn.completed",
      state: "running",
      payload: {
        type: "turn.completed",
        usage: { input_tokens: 37309, cached_input_tokens: 28160, output_tokens: 104 },
      },
      createdAt: "now",
    }, "codex");
    expect(view.kind).toBe("usage");
    expect(view.presentation).toEqual({
      type: "usage", tokensIn: 9149, tokensCached: 28160, tokensOut: 104,
    });
    expect(view.detail).toBe("104 tokens out · 28k cached");
  });

  test("presents thinking progress as reasoning instead of raw JSON", () => {
    const view = taskEventView({
      id: 23,
      taskId: "task",
      type: "agent.system",
      state: "running",
      payload: { type: "system", subtype: "thinking_tokens", estimated_tokens: 5250 },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("reasoning");
    expect(view.title).toBe("Thinking");
    expect(view.detail).toBe("~5.3k tokens so far");
  });

  test("summarizes session init instead of dumping the tool list", () => {
    const view = taskEventView({
      id: 24,
      taskId: "task",
      type: "agent.system",
      state: "running",
      payload: {
        type: "system", subtype: "init", model: "claude-sonnet-5",
        permissionMode: "auto", tools: ["Bash", "Read", "Write"],
        mcp_servers: [{ name: "inter", status: "pending" }],
      },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("lifecycle");
    expect(view.title).toBe("Session started");
    expect(view.detail).toBe("claude-sonnet-5 · 3 tools · 1 MCP server · permission auto");
  });

  test("presents an API retry as a warning signal", () => {
    const view = taskEventView({
      id: 25,
      taskId: "task",
      type: "agent.system",
      state: "running",
      payload: {
        type: "system", subtype: "api_retry",
        attempt: 1, max_retries: 10, retry_delay_ms: 603, error: "unknown",
      },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("API retry");
    expect(view.presentation).toEqual({
      type: "signal", level: "warning", text: "Attempt 1 of 10 · retry in 603ms",
    });
  });

  test("keeps an allowed rate limit event informational", () => {
    const view = taskEventView({
      id: 26,
      taskId: "task",
      type: "agent.rate_limit_event",
      state: "running",
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed", rateLimitType: "five_hour",
          resetsAt: Math.round(Date.now() / 1_000) + 120,
          overageStatus: "rejected", isUsingOverage: false,
        },
      },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Rate limit");
    expect(view.presentation?.level).toBe("info");
    expect(view.presentation?.text).toContain("five hour · allowed · resets in");
    expect(view.presentation?.text).toContain("overage off");
  });

  test("marks Claude tool results as technical echoes", () => {
    const view = taskEventView({
      id: 27,
      taskId: "task",
      type: "agent.user",
      state: "running",
      payload: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("raw");
    expect(view.title).toBe("Tool result");
    expect(view.detail).toBe("ok");
    expect(view.minor).toBe(true);
  });

  test("renders a Claude thinking block as reasoning text", () => {
    const view = taskEventView({
      id: 28,
      taskId: "task",
      type: "agent.assistant",
      state: "running",
      payload: {
        type: "assistant",
        message: {
          model: "claude-opus-5", role: "assistant",
          content: [{ type: "thinking", thinking: "The 404 should read as an unrouted task.", signature: "sig" }],
        },
      },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("reasoning");
    expect(view.title).toBe("Reasoning");
    expect(view.detail).toBe("The 404 should read as an unrouted task.");
    expect(view.minor).toBeUndefined();
  });

  test("prefers the tool_use block when a message mixes thinking and tools", () => {
    const view = taskEventView({
      id: 29,
      taskId: "task",
      type: "agent.assistant",
      state: "running",
      payload: {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "tool_use", name: "Bash", input: { command: "bun test" } },
          ],
        },
      },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("command");
    expect(view.presentation).toEqual({ type: "command", command: "bun test" });
  });

  test("folds the thinking token ticker away as minor", () => {
    const view = taskEventView({
      id: 30,
      taskId: "task",
      type: "agent.system",
      state: "running",
      payload: { type: "system", subtype: "thinking_tokens", estimated_tokens: 5250, estimated_tokens_delta: 100 },
      createdAt: "now",
    }, "claude");
    expect(view.kind).toBe("reasoning");
    expect(view.detail).toBe("~5.3k tokens so far");
    expect(view.minor).toBe(true);
  });

  test("names hook plumbing instead of dumping JSON", () => {
    const view = taskEventView({
      id: 31,
      taskId: "task",
      type: "agent.system",
      state: "running",
      payload: {
        type: "system", subtype: "hook_response",
        hook_name: "SessionStart:startup", hook_event: "SessionStart",
        outcome: "success", exit_code: 0,
      },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Hook finished");
    expect(view.detail).toBe("SessionStart:startup · success");
    expect(view.minor).toBe(true);
  });

  test("summarizes an OpenCode step finish as usage", () => {
    const view = taskEventView({
      id: 32,
      taskId: "task",
      type: "agent.step_finish",
      state: "running",
      payload: {
        type: "step_finish",
        part: {
          type: "step-finish", reason: "tool-calls",
          cost: 0.1935846,
          tokens: { total: 30820, input: 30650, output: 116, reasoning: 54, cache: { read: 28000, write: 0 } },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("usage");
    expect(view.title).toBe("Step finished");
    expect(view.detail).toBe("tool calls · 116 tokens out");
    expect(view.presentation).toEqual({
      type: "usage", costUsd: 0.1935846,
      tokensIn: 30650, tokensOut: 116, tokensCached: 28000,
    });
    expect(view.minor).toBe(true);
  });

  test("surfaces a nested provider error message", () => {
    const view = taskEventView({
      id: 33,
      taskId: "task",
      type: "agent.error",
      state: "running",
      payload: {
        type: "error",
        error: { name: "APIError", data: { message: "Insufficient balance.", statusCode: 401 } },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("error");
    expect(view.detail).toBe("Insufficient balance.");
  });

  test("keeps quiet heartbeats minor and stalled ones visible", () => {
    const quiet = taskEventView({
      id: 34, taskId: "task", type: "heartbeat", state: "running",
      payload: { elapsedMs: 50_000, silentMs: 1_000, stalled: false }, createdAt: "now",
    }, "claude");
    const stalled = taskEventView({
      id: 35, taskId: "task", type: "heartbeat", state: "running",
      payload: { elapsedMs: 140_000, silentMs: 109_000, stalled: true }, createdAt: "now",
    }, "claude");
    expect(quiet.minor).toBe(true);
    expect(stalled.minor).toBeUndefined();
    expect(stalled.detail).toBe("No agent event for 109s");
  });

  test("shows the question a needs_input event parks on", () => {
    const view = taskEventView({
      id: 36, taskId: "task", type: "needs_input", state: "needs_input",
      payload: { question: "Expand the write scope to api/internal/cron/builder.go?", completion: { blocked: true } },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Worker needs input");
    expect(view.detail).toBe("Expand the write scope to api/internal/cron/builder.go?");
  });

  test("shows the answer an answered event carried", () => {
    const view = taskEventView({
      id: 37, taskId: "task", type: "answered", state: "queued",
      payload: { attempt: 1, answer: "Yes, expand it." },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Question answered");
    expect(view.detail).toBe("Yes, expand it.");
  });

  test("renders an answered event with no answer key as a plain row", () => {
    const view = taskEventView({
      id: 38, taskId: "task", type: "answered", state: "queued",
      payload: { attempt: 2 },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Question answered");
    expect(view.detail).toBeUndefined();
  });

  test("reduces each tool result shape to the figure worth showing", () => {
    const outcome = (toolUseResult: unknown, isError = false) => taskEventView({
      id: 42, taskId: "task", type: "agent.user", state: "running",
      payload: {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: isError }] },
        tool_use_result: toolUseResult,
      },
      createdAt: "now",
    }, "claude");

    const read = outcome({ type: "text", file: { filePath: "/repo/a.rs", numLines: 298, totalLines: 298 } });
    expect(read.presentation?.outcome).toBe("298 lines read");
    expect(read.actionId).toBe("toolu_1");
    expect(read.minor).toBe(true);

    expect(outcome({ file: { numLines: 40, totalLines: 298 } }).presentation?.outcome)
      .toBe("40 of 298 lines");
    expect(outcome({
      filePath: "/repo/a.rs",
      structuredPatch: [{ lines: ["-old", "+new", "+extra", " same"] }],
    }).presentation?.outcome).toBe("+2 −1");
    expect(outcome({ stdout: "one\ntwo\n", stderr: "", interrupted: false }).presentation?.outcome)
      .toBe("2 lines out");
    expect(outcome({ stdout: "", stderr: "" }).presentation?.outcome).toBe("no output");
    expect(outcome({ stdout: "", interrupted: true }).presentation?.outcome).toBe("interrupted");
    expect(outcome("Error: File does not exist.", true).presentation?.outcome)
      .toBe("Error: File does not exist.");
    expect(outcome({}).presentation).toBeUndefined();
  });

  test("carries the thinking-token delta so a run total can be summed", () => {
    const view = taskEventView({
      id: 41, taskId: "task", type: "agent.system", state: "running",
      payload: {
        type: "system", subtype: "thinking_tokens",
        estimated_tokens: 472, estimated_tokens_delta: 22,
      },
      createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Thinking");
    expect(view.detail).toBe("~472 tokens so far");
    expect(view.presentation).toEqual({ type: "usage", tokensThinking: 22 });
  });

  test("keeps the reason on a failed tool hook", () => {
    const view = taskEventView({
      id: 36, taskId: "task", type: "agent.hook", state: "running",
      payload: {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        tool_input: { file_path: "/repo/AGENTS.md" },
        tool_use_id: "toolu_1",
        error: "File does not exist.",
      },
      createdAt: "now",
    }, "claude");
    expect(view.phase).toBe("failed");
    expect(view.detail).toBe("/repo/AGENTS.md · File does not exist.");
    expect(view.actionId).toBe("toolu_1");
  });

  test("tags each provider's events with the id that pairs them", () => {
    const claude = taskEventView({
      id: 37, taskId: "task", type: "agent.assistant", state: "running",
      payload: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }] },
      },
      createdAt: "now",
    }, "claude");
    const opencode = taskEventView({
      id: 38, taskId: "task", type: "agent.tool_use", state: "running",
      payload: {
        type: "tool_use",
        part: { type: "tool", tool: "read", callID: "call_9", id: "prt_9",
          state: { status: "completed", input: { filePath: "a.ts" } } },
      },
      createdAt: "now",
    }, "opencode");
    const codex = taskEventView({
      id: 39, taskId: "task", type: "agent.item.completed", state: "running",
      payload: {
        type: "item.completed",
        item: { id: "item_2", type: "command_execution", command: "ls", status: "completed" },
      },
      createdAt: "now",
    }, "codex");
    expect(claude.actionId).toBe("toolu_1");
    // The call id, not the part id: the part changes between started and done.
    expect(opencode.actionId).toBe("call_9");
    expect(codex.actionId).toBe("item_2");
  });

  test("reports a skipped oversized line without ending the trace", () => {
    const view = taskEventView({
      id: 40, taskId: "task", type: "event_dropped", state: "running",
      payload: { bytes: 131_072, limit: 65_536 }, createdAt: "now",
    }, "claude");
    expect(view.title).toBe("Large event skipped");
    expect(view.presentation).toEqual({
      type: "signal",
      level: "warning",
      text: "128 KB payload over the 64 KB line limit — one event skipped, the trace continues",
    });
  });

  test("summarizes an Antigravity run receipt instead of dumping the envelope", () => {
    const view = taskEventView({
      id: 41, taskId: "task", type: "agent.event", state: "completed",
      payload: {
        event: "result",
        result: {
          conversation_id: "e2eb985f",
          status: "SUCCESS",
          response: "### Summary",
          duration_seconds: 40.697358,
          num_turns: 1,
          usage: {
            input_tokens: 73_169, output_tokens: 33_603, thinking_tokens: 24_633,
            cache_read_tokens: 146_969, total_tokens: 106_772,
          },
        },
      },
      createdAt: "now",
    }, "antigravity");
    expect(view.kind).toBe("usage");
    expect(view.phase).toBe("completed");
    expect(view.title).toBe("Run summary");
    expect(view.detail).toBe("1 turn · 41s");
    expect(view.presentation).toEqual({
      type: "usage",
      turns: 1,
      durationMs: 40_697,
      tokensIn: 73_169,
      tokensOut: 33_603,
      tokensCached: 146_969,
      tokensThinking: 24_633,
    });
  });

  test("marks a failed Antigravity run with its reason", () => {
    const view = taskEventView({
      id: 42, taskId: "task", type: "agent.event", state: "failed",
      payload: {
        event: "result",
        result: {
          conversation_id: "", status: "ERROR", response: "",
          error: "authentication failed or timed out",
          duration_seconds: 0, num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        },
      },
      createdAt: "now",
    }, "antigravity");
    expect(view.phase).toBe("failed");
    expect(view.detail).toBe("authentication failed or timed out");
    expect(view.presentation?.level).toBe("error");
  });

  test("names an Antigravity tool step and pairs its start with its result", () => {
    const started = taskEventView({
      id: 43, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: {
          conversation_id: "e2eb985f", step_index: 3, state: "ACTIVE", step_type: "tool",
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/website/index.html" } },
        },
      },
      createdAt: "now",
    }, "antigravity");
    const done = taskEventView({
      id: 44, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: {
          conversation_id: "e2eb985f", step_index: 3, state: "DONE", step_type: "tool",
          tool_name: "view_file", duration_seconds: 0.131406,
          tool_info: {
            name: "view_file",
            parameters: { AbsolutePath: "/repo/website/index.html" },
            output: "115 lines, 5551 bytes",
          },
        },
      },
      createdAt: "now",
    }, "antigravity");
    expect(started.kind).toBe("file");
    expect(started.title).toBe("Read file");
    expect(started.detail).toBe("/repo/website/index.html");
    expect(started.phase).toBe("started");
    expect(done.phase).toBe("completed");
    expect(done.presentation).toEqual({
      type: "file", path: "/repo/website/index.html", outcome: "115 lines, 5551 bytes",
    });
    expect(done.actionId).toBe(started.actionId);
    expect(started.actionId).toBe("e2eb985f:3");
  });

  test("keeps Antigravity command and streamed reply steps readable", () => {
    const command = taskEventView({
      id: 45, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: {
          conversation_id: "c1", step_index: 5, state: "ACTIVE", step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "bun test", Cwd: "/repo" } },
        },
      },
      createdAt: "now",
    }, "antigravity");
    const reply = taskEventView({
      id: 46, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: {
          conversation_id: "c1", step_index: 11, state: "ACTIVE", step_type: "agent_response",
          text_delta: "### Summary of Improvements",
        },
      },
      createdAt: "now",
    }, "antigravity");
    expect(command.kind).toBe("command");
    expect(command.presentation).toEqual({ type: "command", command: "bun test", path: "/repo" });
    expect(reply.kind).toBe("message");
    expect(reply.title).toBe("Agent message");
    expect(reply.detail).toBe("### Summary of Improvements");
  });

  test("folds Antigravity session, prompt, and per-turn steps into named rows", () => {
    const init = taskEventView({
      id: 47, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "init",
        conversation_id: "c1",
        init: { model: "gemini-3.6-flash-medium", cwd: "/repo", tools: ["view_file", "run_command"],
          permission_mode: "always-proceed" },
      },
      createdAt: "now",
    }, "antigravity");
    const turn = taskEventView({
      id: 48, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: {
          conversation_id: "c1", step_index: 2, state: "DONE", step_type: "agent_response",
          duration_seconds: 2.638916,
          usage: { input_tokens: 8_962, output_tokens: 424, thinking_tokens: 346,
            cache_read_tokens: 12_216, total_tokens: 9_386 },
        },
      },
      createdAt: "now",
    }, "antigravity");
    const prompt = taskEventView({
      id: 49, taskId: "task", type: "agent.event", state: "running",
      payload: {
        event: "step_update",
        step_update: { conversation_id: "c1", step_index: 0, state: "DONE", step_type: "user_input" },
      },
      createdAt: "now",
    }, "antigravity");
    expect(init.title).toBe("Session started");
    expect(init.detail).toBe("gemini-3.6-flash-medium · 2 tools · permission always-proceed");
    expect(turn.title).toBe("Turn completed");
    expect(turn.detail).toBe("424 tokens out · 12k cached");
    expect(turn.presentation?.tokensThinking).toBe(346);
    expect(prompt.title).toBe("Prompt received");
    expect(prompt.minor).toBe(true);
  });

  test("presents pi's own event vocabulary", () => {
    const view = (payload: Record<string, unknown>) =>
      taskEventView({ id: 1, taskId: "task", type: "agent.event", state: "running", payload, createdAt: "now" }, "pi");

    expect(view({ type: "session", version: 3, id: "019fc931", cwd: "/repo" }).title)
      .toBe("Session started");

    const thinking = view({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "weighing options" },
    });
    expect(thinking.kind).toBe("reasoning");
    expect(thinking.minor).toBe(true);

    const message = view({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    });
    expect(message.kind).toBe("message");
    expect(message.detail).toBe("Hello");

    const tool = view({
      type: "tool_execution_start", toolCallId: "call_abc123", toolName: "bash",
      args: { command: "ls -la" },
    });
    expect(tool.kind).toBe("command");
    expect(tool.phase).toBe("started");
    expect(tool.actionId).toBe("call_abc123");

    const settled = view({ type: "agent_settled" });
    expect(settled.title).toBe("Run finished");
    expect(settled.phase).toBe("completed");
  });

  test("coalesces a pi thinking block into one row at its boundary", () => {
    const view = taskEventView({
      id: 1, taskId: "task", type: "agent.event", state: "running",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end", contentIndex: 0, content: "The 404 should read as an unrouted task.",
        },
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("reasoning");
    expect(view.title).toBe("Thinking");
    expect(view.detail).toBe("The 404 should read as an unrouted task.");
    expect(view.minor).toBe(true);
  });

  test("renders a whole pi thinking block as one row, not one per delta", () => {
    const view = (payload: Record<string, unknown>) =>
      taskEventView({ id: 1, taskId: "task", type: "agent.event", state: "running", payload, createdAt: "now" }, "pi");
    const rows = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "weighing" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " the " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "options" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "weighing the options" } },
    ].map(view);
    // The deltas stay token-sized minor rows; the assembled block surfaces
    // once, on the boundary, where the content field carries the whole block.
    expect(rows.filter((row) => row.kind === "reasoning" && row.title === "Thinking").map((row) => row.detail))
      .toEqual(["weighing", "the", "options", "weighing the options"]);
    expect(rows.at(-1)?.minor).toBe(true);
  });

  test("keeps pi's assembled thinking reachable on the closing message", () => {
    const view = taskEventView({
      id: 2, taskId: "task", type: "agent.event", state: "running",
      payload: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing the two surface options" },
            { type: "text", text: "Done." },
          ],
          stopReason: "stop",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("usage");
    expect(view.rawText).toContain("weighing the two surface options");
  });

  test("reads a pi edit off its result once the arguments are gone", () => {
    // Verbatim from a real run: tool_execution_end carries `args: null`, so the
    // path and the change have to come out of the result or the row degrades to
    // a raw JSON dump.
    const view = taskEventView({
      id: 1, taskId: "task", type: "agent.tool_execution_end", state: "running",
      payload: {
        type: "tool_execution_end",
        toolCallId: "call_00_ET_jwxrRxDVTa5pHrBuS0x97638",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in .inter-test/pi-tools.txt." }],
          details: {
            diff: "-1 state: one\n+1 state: two",
            patch: "--- .inter-test/pi-tools.txt\n+++ .inter-test/pi-tools.txt\n@@ -1,1 +1,1 @@\n-state: one\n+state: two\n",
            firstChangedLine: 1,
          },
        },
        isError: false,
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("file");
    expect(view.title).toBe("Edit file");
    expect(view.presentation?.type).toBe("file");
    expect(view.presentation?.path).toBe(".inter-test/pi-tools.txt");
    expect(view.presentation?.change).toBe("one → two");
    expect(view.presentation?.outcome).toContain("replaced 1 block");
  });

  test("does not present pi's echoed prompt as an agent message", () => {
    const view = (payload: Record<string, unknown>) =>
      taskEventView({ id: 1, taskId: "task", type: "agent.event", state: "running", payload, createdAt: "now" }, "pi");
    const prompt = { role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] };

    expect(view({ type: "message_start", message: prompt }).title).toBe("Prompt received");
    expect(view({ type: "message_end", message: prompt }).kind).toBe("lifecycle");
    // The assistant's opening message is empty; the text arrives as deltas.
    expect(view({ type: "message_start", message: { role: "assistant", content: [] } }).minor).toBe(true);
  });

  test("reads a pi failure from stopReason, since json mode still exits 0", () => {
    const view = taskEventView({
      id: 2, taskId: "task", type: "agent.event", state: "running",
      payload: {
        type: "message_end",
        message: {
          role: "assistant", content: [], stopReason: "error",
          errorMessage: "invalid x-api-key",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("error");
    expect(view.phase).toBe("failed");
    expect(view.detail).toContain("invalid x-api-key");
    expect(view.presentation?.tokensIn).toBe(100);
  });

  test("presents the flat message_end shape pi actually emits", () => {
    // Verbatim from a real run, read out of the app's event inspector: the
    // openai-completions adapter hoists `role` and `usage` to the top level,
    // unlike the nested `message` shape the documented wire contract uses.
    const view = taskEventView({
      id: 2, taskId: "task", type: "agent.event", state: "running",
      payload: {
        api: "openai-completions",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
        rawStopReason: "tool_calls",
        responseId: "073984d3-a055-4e04-90fe-73944037863f",
        role: "assistant",
        stopReason: "toolUse",
        type: "message_end",
        usage: {
          cacheRead: 15104,
          cacheWrite: 0,
          input: 1938,
          output: 113,
          reasoning: 30,
          totalTokens: 17155,
        },
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("usage");
    expect(view.title).toBe("Turn summary");
    // totalTokens 17155 = input 1938 + cacheRead 15104 + output 113, exactly,
    // so pi's `input` already excludes the cache read (unlike codex).
    expect(view.presentation).toMatchObject({
      type: "usage",
      tokensIn: 1938,
      tokensOut: 113,
      tokensCached: 15104,
      tokensThinking: 30,
    });
  });

  test("renders a flat pi user echo as a prompt, not an agent message", () => {
    const view = taskEventView({
      id: 1, taskId: "task", type: "agent.event", state: "running",
      payload: {
        type: "message_end",
        role: "user",
        content: [{ type: "text", text: "Reply with exactly: ok" }],
      },
      createdAt: "now",
    }, "pi");
    expect(view.kind).toBe("lifecycle");
    expect(view.title).toBe("Prompt received");
  });

  test("renders an MCP tool call as a readable row, not the output dump", () => {
    // Verbatim from a real run: the memory tool's part carries the call at
    // `part.tool`, the arguments in `state.input`, an empty `state.title`, and
    // the whole JSON result echoed in `state.output`. The row must read from
    // the input, never from the output blob.
    const view = taskEventView({
      id: 50,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        timestamp: 1785810319300,
        sessionID: "ses_035691fdbffeYv2l2Kjpxg0EGq",
        part: {
          type: "tool",
          tool: "inter_memory",
          callID: "call_00_R90nAQSOof8q5Z7SoIMC6984",
          id: "prt_fca96f715001ZBZFzjfzFj8uB5",
          sessionID: "ses_035691fdbffeYv2l2Kjpxg0EGq",
          messageID: "msg_fca96e14f001RiFCTFOeQCavx1",
          state: {
            input: { action: "list", cwd: "/Users/malico/desgn/inter" },
            metadata: { truncated: false },
            output: "[{ \"key\": \"delegation-model-preference\" }]",
            status: "completed",
            time: { start: 1785810319290, end: 1785810319298 },
            title: "",
          },
        },
      },
      createdAt: "now",
    }, "opencode");

    expect(view.kind).toBe("tool");
    expect(view.phase).toBe("completed");
    expect(view.title).toBe("Inter Memory");
    expect(view.detail).toBe("Action: list");
    expect(view.detail).not.toContain("[{");
    expect(view.presentation).toEqual({ type: "tool", text: "Action: list", outcome: "completed" });
    expect(view.actionId).toBe("call_00_R90nAQSOof8q5Z7SoIMC6984");
  });

  test("marks a still-running MCP tool call as started", () => {
    const view = taskEventView({
      id: 51,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "inter_memory",
          callID: "call_00_pending",
          state: {
            status: "running",
            input: { action: "get", cwd: "/repo" },
            title: "",
          },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("tool");
    expect(view.phase).toBe("started");
    expect(view.presentation).toEqual({ type: "tool", text: "Action: get", outcome: "running" });
  });

  test("reads a failed MCP tool call from its state error", () => {
    // opencode reports failed calls with `status: "error"` and the reason in
    // `state.error`, not in the part type — exactly what the escape-probe rows
    // in the live database carry.
    const make = (status: string) => taskEventView({
      id: 52,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "inter_memory",
          callID: "call_00_failed",
          state: {
            status,
            input: { action: "set", cwd: "/repo" },
            error: "Tool execution aborted",
            title: "",
          },
        },
      },
      createdAt: "now",
    }, "opencode");

    const errored = make("error");
    expect(errored.kind).toBe("error");
    expect(errored.phase).toBe("failed");
    expect(errored.title).toBe("Inter Memory failed");
    expect(errored.detail).toBe("Action: set · Tool execution aborted");
    expect(errored.actionId).toBe("call_00_failed");

    const failed = make("failed");
    expect(failed.kind).toBe("error");
    expect(failed.title).toBe("Inter Memory failed");
  });

  test("leaves a label-less tool part in the raw fallback", () => {
    const view = taskEventView({
      id: 53,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: { type: "tool", state: { status: "completed", input: {} } },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("raw");
    expect(view.rawText).toContain("tool_use");
  });

  test("reduces an unrecognized tool's JSON output to a count", () => {
    const view = taskEventView({
      id: 54,
      taskId: "task",
      type: "agent.tool_use",
      state: "running",
      payload: {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "inter_tasks",
          callID: "call_00_count",
          state: {
            status: "completed",
            input: { queryId: 7 },
            output: "[{ \"id\": 1 }, { \"id\": 2 }, { \"id\": 3 }]",
            title: "",
          },
        },
      },
      createdAt: "now",
    }, "opencode");
    expect(view.kind).toBe("tool");
    expect(view.title).toBe("Inter Tasks");
    expect(view.detail).toBe("3 items");
    expect(view.detail).not.toContain("[{");
  });
});
