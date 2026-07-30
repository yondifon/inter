import { describe, expect, test } from "bun:test";
import { commandFor, finalText } from "../src/adapters";
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
});
