import { describe, expect, test } from "bun:test";
import { canResumeSession, commandFor, finalText, resumeCommandFor, sessionIdFrom } from "../src/adapters";
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
      "--permission-mode", "acceptEdits", "review",
    ]);
  });

  test("supports custom Antigravity command templates", () => {
    expect(commandFor({ ...base, provider: "antigravity", command: ["agy", "--cwd", "{cwd}", "{prompt}"] }, "test", "/repo"))
      .toEqual(["agy", "--cwd", "/repo", "test"]);
  });

  test("allows Codex delegation outside Git repositories", () => {
    expect(commandFor({ ...base, provider: "codex" }, "review", "/workspace"))
      .toContain("--skip-git-repo-check");
  });

  test("extracts Claude final response", () => {
    expect(finalText(base, [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", result: "done" }),
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
    expect(command).toContain("--settings");
    expect(command.at(-1)).toBe("continue");
  });

  test("resumes Codex through the exec resume subcommand", () => {
    const command = resumeCommandFor({ ...base, provider: "codex" }, "continue", "/repo", "thread-9");
    expect(command.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-9"]);
    expect(command).toContain("--json");
    expect(command[command.indexOf("-c") + 1]).toBe('sandbox_mode="workspace-write"');
  });

  test("resumes OpenCode with the prior session flag", () => {
    const command = resumeCommandFor({ ...base, provider: "opencode" }, "continue", "/repo", "ses_1");
    expect(command[command.indexOf("--session") + 1]).toBe("ses_1");
    expect(command[command.indexOf("--dir") + 1]).toBe("/repo");
  });

  test("refuses resume for custom commands and Antigravity", () => {
    expect(canResumeSession(base)).toBe(true);
    expect(canResumeSession({ ...base, command: ["agy", "{prompt}"] })).toBe(false);
    expect(canResumeSession({ ...base, provider: "antigravity" })).toBe(false);
    expect(() => resumeCommandFor({ ...base, provider: "antigravity" }, "p", "/repo", "s")).toThrow(
      "profile cannot resume sessions",
    );
  });

  test("extracts each provider's session id from its real event shape", () => {
    expect(sessionIdFrom("claude", { type: "system", session_id: "11296fa9" })).toBe("11296fa9");
    expect(sessionIdFrom("codex", { type: "thread.started", thread_id: "019fb42b" })).toBe("019fb42b");
    expect(sessionIdFrom("opencode", { type: "step_start", sessionID: "ses_04bd" })).toBe("ses_04bd");
    expect(sessionIdFrom("claude", { type: "assistant" })).toBeUndefined();
    expect(sessionIdFrom("claude", { session_id: 42 })).toBeUndefined();
    expect(sessionIdFrom("antigravity", { session_id: "x" })).toBeUndefined();
  });
});
