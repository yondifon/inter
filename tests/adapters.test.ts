import { describe, expect, test } from "bun:test";
import { canResumeSession, commandFor, finalText, resumeCommandFor, sessionIdFrom, writeTargetsFrom } from "../src/adapters";
import type { Profile } from "../src/types";

const base: Profile = {
  id: "worker",
  label: "Worker",
  provider: "claude",
  model: "sonnet",
  enabled: true,
  env: {},
  capabilities: [],
};

describe("CLI adapters", () => {
  test("builds isolated Claude print command", () => {
    expect(commandFor(base, "review", "/repo")).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet",
      "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "review",
    ]);
  });

  test("supports custom Antigravity command templates", () => {
    expect(commandFor({ ...base, provider: "antigravity", command: ["agy", "--cwd", "{cwd}", "{prompt}"] }, "test", "/repo"))
      .toEqual(["agy", "--cwd", "/repo", "test"]);
  });

  test("builds a headless Antigravity print command", () => {
    expect(commandFor({ ...base, provider: "antigravity" }, "review", "/repo", "gemini-3.6-flash-low"))
      .toEqual([
        "agy", "--print", "review", "--output-format", "stream-json", "--model", "gemini-3.6-flash-low",
        "--new-project", "--add-dir", "/repo", "--mode", "accept-edits",
        "--dangerously-skip-permissions",
      ]);
  });

  test("allows Codex delegation outside Git repositories", () => {
    const command = commandFor({ ...base, provider: "codex" }, "review", "/workspace");
    expect(command).toContain("--skip-git-repo-check");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).not.toContain("--sandbox");
    expect(command).not.toContain('approval_policy="never"');
  });

  test("passes reasoning effort to Codex as a quoted TOML config override", () => {
    const command = commandFor({ ...base, provider: "codex" }, "review", "/workspace", "gpt-5.6-luna", undefined, "max");
    expect(command).toContain("-c");
    expect(command).toContain('model_reasoning_effort="max"');
  });

  test("passes reasoning effort to OpenCode as a variant", () => {
    const command = commandFor({ ...base, provider: "opencode" }, "review", "/workspace", "opencode-go/gpt-5.6-luna", undefined, "high");
    expect(command.join(" ")).toContain("--variant high");
  });

  test("omits the effort flag entirely when no effort is requested", () => {
    const codex = commandFor({ ...base, provider: "codex" }, "review", "/workspace");
    const opencode = commandFor({ ...base, provider: "opencode" }, "review", "/workspace");
    expect(codex).not.toContain("-c");
    expect(opencode).not.toContain("--variant");
  });

  test("passes reasoning effort to Claude as a session flag", () => {
    const command = commandFor({ ...base, provider: "claude" }, "review", "/workspace", "opus", undefined, "max");
    expect(command.join(" ")).toContain("--effort max");
  });

  test("drops effort for Antigravity, where the level is part of the model id", () => {
    const command = commandFor({ ...base, provider: "antigravity" }, "review", "/workspace", "gemini-3.6-flash-low", undefined, "max");
    expect(command).not.toContain("--effort");
    expect(command).not.toContain("max");
  });

  test("keeps reasoning effort when resuming a session", () => {
    const command = resumeCommandFor(
      { ...base, provider: "codex" },
      "continue",
      "/repo",
      "thread-9",
      "gpt-5.6-luna",
      undefined,
      "xhigh",
    );
    expect(command).toContain('model_reasoning_effort="xhigh"');
  });

  test("extracts Claude final response", () => {
    expect(finalText(base, [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n"))).toBe("done");
  });

  test("reads an Antigravity reply out of its result envelope", () => {
    const profile = { ...base, provider: "antigravity" as const };
    expect(finalText(profile, [
      JSON.stringify({ event: "init", init: { model: "gemini-3.6-flash-medium" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
    ].join("\n"))).toBe("done");
  });

  test("overrides a profile model per task", () => {
    expect(commandFor(base, "review", "/repo", "opus")).toContain("opus");
    expect(commandFor(base, "review", "/repo", "opus")).not.toContain("sonnet");
  });

  test("injects scoped Claude HTTP hooks for delegated runs", () => {
    const command = commandFor(base, "review", "/repo", "sonnet", "http://127.0.0.1/hooks/task");
    const settings = JSON.parse(command[command.indexOf("--settings") + 1]!);
    expect(settings.hooks.PreToolUse[0].hooks[0].url).toBe("http://127.0.0.1/hooks/task");
    expect(settings.hooks.SubagentStop).toBeDefined();
  });

  test("resumes a Claude session with the captured session id", () => {
    const command = resumeCommandFor(base, "continue", "/repo", "sess-1", "sonnet", "http://127.0.0.1/hooks/task");
    expect(command[command.indexOf("--resume") + 1]).toBe("sess-1");
    expect(command.slice(command.indexOf("--allowedTools"), command.indexOf("--allowedTools") + 2))
      .toEqual(["--allowedTools", "Bash"]);
    expect(command).toContain("--settings");
    expect(command.at(-1)).toBe("continue");
  });

  test("resumes Codex through the exec resume subcommand", () => {
    const command = resumeCommandFor({ ...base, provider: "codex" }, "continue", "/repo", "thread-9");
    expect(command.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-9"]);
    expect(command).toContain("--json");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).not.toContain('sandbox_mode="workspace-write"');
  });

  test("resumes OpenCode with the prior session flag", () => {
    const command = resumeCommandFor({ ...base, provider: "opencode" }, "continue", "/repo", "ses_1");
    expect(command[command.indexOf("--session") + 1]).toBe("ses_1");
    expect(command[command.indexOf("--dir") + 1]).toBe("/repo");
  });

  test("resumes Antigravity with the prior conversation id", () => {
    const command = resumeCommandFor(
      { ...base, provider: "antigravity" },
      "continue",
      "/repo",
      "conversation-1",
      "gemini-3.6-flash-medium",
    );
    expect(command[command.indexOf("--conversation") + 1]).toBe("conversation-1");
    expect(command[command.indexOf("--add-dir") + 1]).toBe("/repo");
    expect(command[command.indexOf("--print") + 1]).toBe("continue");
  });

  test("refuses resume for custom commands", () => {
    expect(canResumeSession(base)).toBe(true);
    expect(canResumeSession({ ...base, command: ["agy", "{prompt}"] })).toBe(false);
    expect(canResumeSession({ ...base, provider: "antigravity" })).toBe(true);
  });

  test("extracts each provider's session id from its real event shape", () => {
    expect(sessionIdFrom("claude", { type: "system", session_id: "11296fa9" })).toBe("11296fa9");
    expect(sessionIdFrom("codex", { type: "thread.started", thread_id: "019fb42b" })).toBe("019fb42b");
    expect(sessionIdFrom("opencode", { type: "step_start", sessionID: "ses_04bd" })).toBe("ses_04bd");
    expect(sessionIdFrom("claude", { type: "assistant", session_id: "child" })).toBeUndefined();
    expect(sessionIdFrom("claude", { session_id: 42 })).toBeUndefined();
    expect(sessionIdFrom("claude", { session_id: "   " })).toBeUndefined();
    expect(sessionIdFrom("codex", { thread_id: " thread-1 " })).toBeUndefined();
    expect(sessionIdFrom("opencode", { type: "tool_use", sessionID: "child" })).toBeUndefined();
    expect(sessionIdFrom("antigravity", {
      event: "init",
      conversation_id: "conversation-1",
    })).toBe("conversation-1");
    expect(sessionIdFrom("antigravity", {
      event: "result",
      result: { conversation_id: "conversation-2" },
    })).toBe("conversation-2");
    expect(sessionIdFrom("antigravity", {
      event: "step_update",
      conversation_id: "child",
    })).toBeUndefined();
    expect(sessionIdFrom("antigravity", { session_id: "x" })).toBeUndefined();
    expect(sessionIdFrom("pi", { type: "session", version: 3, id: "019fc931", cwd: "/repo" }))
      .toBe("019fc931");
    expect(sessionIdFrom("pi", { type: "message_end", id: "child" })).toBeUndefined();
  });

  test("builds a headless pi json command", () => {
    expect(commandFor({ ...base, provider: "pi" }, "review", "/repo", "opencode/kimi-k3"))
      .toEqual([
        "pi", "--mode", "json", "--model", "opencode/kimi-k3", "--no-approve", "review",
      ]);
  });

  test("passes pi reasoning effort through unchanged", () => {
    const command = commandFor({ ...base, provider: "pi" }, "review", "/repo", "opencode/kimi-k3", undefined, "xhigh");
    expect(command[command.indexOf("--thinking") + 1]).toBe("xhigh");
  });

  test("resumes pi by exact session id", () => {
    expect(canResumeSession({ ...base, provider: "pi" })).toBe(true);
    const command = resumeCommandFor(
      { ...base, provider: "pi" }, "continue", "/repo", "019fc931", "opencode/kimi-k3",
    );
    expect(command[command.indexOf("--session-id") + 1]).toBe("019fc931");
    expect(command).not.toContain("--session");
    expect(command.at(-1)).toBe("continue");
  });
});

describe("writeTargetsFrom", () => {
  test("finds write targets across provider payload shapes", () => {
    expect(writeTargetsFrom({
      part: { type: "tool", tool: "write", state: { input: { filePath: "/repo/out.txt" } } },
    })).toEqual(["/repo/out.txt"]);
    expect(writeTargetsFrom({
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "notes.md" } }] },
    })).toEqual(["notes.md"]);
    expect(writeTargetsFrom({
      tool_name: "Edit", tool_input: { file_path: "src/app.ts" },
    })).toEqual(["src/app.ts"]);
  });

  test("ignores reads and toolless events", () => {
    expect(writeTargetsFrom({
      part: { type: "tool", tool: "read", state: { input: { filePath: "/repo/in.txt" } } },
    })).toEqual([]);
    expect(writeTargetsFrom({ type: "message", text: "hello" })).toEqual([]);
  });

  test("finds pi write targets under args and arguments", () => {
    expect(writeTargetsFrom({
      type: "tool_execution_start", toolCallId: "call_1", toolName: "write",
      args: { path: "src/app.ts", content: "x" },
    })).toEqual(["src/app.ts"]);
    expect(writeTargetsFrom({
      message: { content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: { path: "notes.md" } }] },
    })).toEqual(["notes.md"]);
    expect(writeTargetsFrom({
      type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" },
    })).toEqual([]);
  });

  test("ignores pi's streamed tool arguments, which carry truncated paths", () => {
    // Observed on pi 0.82.1: every toolcall_delta repeats the message so far,
    // so a write to probe.txt streams through as `pro`, `probe`, `probe.txt`.
    expect(writeTargetsFrom({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "be" },
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "probe" } }],
      },
    })).toEqual([]);
  });
});

describe("finalText", () => {
  const pi: Profile = { ...base, provider: "pi" };

  test("joins only the text blocks of pi's last assistant message", () => {
    const raw = [
      JSON.stringify({ type: "session", id: "019fc931", cwd: "/repo" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "first pass" }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing options" },
            { type: "text", text: "Done: " },
            { type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts" } },
            { type: "text", text: "two files changed." },
          ],
          stopReason: "stop",
        },
      }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n");
    expect(finalText(pi, raw)).toBe("Done: two files changed.");
  });

  test("falls back to raw when pi emitted no assistant text", () => {
    expect(finalText(pi, "not json at all")).toBe("not json at all");
  });
});
