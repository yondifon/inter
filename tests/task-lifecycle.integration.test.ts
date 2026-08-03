import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cancelTask, delegate, getTask, reply, resumeTask, waitForTasks } from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile } from "../src/types";

const integrationTest = process.env.INTER_SANDBOX_INTEGRATION === "1" ? test : test.skip;
const roots: string[] = [];
const initialPath = process.env.PATH;

afterEach(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_ROOTS;
  process.env.PATH = initialPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(command: string[]): { cwd: string; profile: Profile } {
  const root = mkdtempSync(join(tmpdir(), "inter-lifecycle-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  const profile: Profile = {
    id: "fake",
    label: "Fake",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
    command,
  };
  stateStore().saveProfiles([profile]);
  return { cwd: root, profile };
}

// Shadows the real `claude` binary with a script so runTask exercises the
// provider argv (including --resume) end to end. The script logs its argv to
// <root>/argv.log for assertions.
function setupClaudeBin(script: string): { cwd: string; profile: Profile } {
  const root = mkdtempSync(join(tmpdir(), "inter-lifecycle-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "claude"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}:${initialPath}`;
  const profile: Profile = {
    id: "fake-claude",
    label: "Fake Claude",
    provider: "claude",
    model: "sonnet",
    enabled: true,
    env: {},
    capabilities: [],
  };
  stateStore().saveProfiles([profile]);
  return { cwd: root, profile };
}

function setupAntigravityBin(script: string): { cwd: string; profile: Profile } {
  const root = mkdtempSync(join(tmpdir(), "inter-lifecycle-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "agy"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}:${initialPath}`;
  const profile: Profile = {
    id: "fake-antigravity",
    label: "Fake Antigravity",
    provider: "antigravity",
    model: "flash",
    enabled: true,
    env: {},
    capabilities: [],
  };
  stateStore().saveProfiles([profile]);
  return { cwd: root, profile };
}

async function waitForAttention(taskId: string) {
  let cursor = stateStore().latestTaskEventId([taskId], true);
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await waitForTasks([taskId], 2_000, undefined, cursor);
    if (result.reason === "attention") return result;
    cursor = result.cursor;
  }
  throw new Error(`task did not reach attention: ${taskId}`);
}

describe("task lifecycle integration", () => {
  integrationTest("cancels the worker process tree", async () => {
    const { cwd, profile } = setup(["/bin/sh", "-c", "sleep 30"]);
    const task = await delegate(profile.id, "wait", cwd, undefined, undefined, {
      scope: { read: [], write: [] },
    });
    const cancelled = await cancelTask(task.id, "no longer useful");
    expect(cancelled).toMatchObject({
      state: "cancelled",
      completion: { code: "cancelled", blocked: true },
    });
    expect(stateStore().listTaskEvents(task.id).at(-1)?.type).toBe("cancelled");
  });

  integrationTest("self-cancels at the delegated timeout", async () => {
    const { cwd, profile } = setup(["/bin/sh", "-c", "sleep 30"]);
    const task = await delegate(profile.id, "wait", cwd, undefined, undefined, {
      scope: { read: [], write: [] },
      timeoutMs: 50,
    });
    const result = await waitForAttention(task.id);
    expect(result.tasks[0]).toMatchObject({
      state: "failed",
      error: "task exceeded timeoutMs 50",
      completion: { code: "timeout" },
    });
  });

  integrationTest("retries a zero-turn Antigravity bootstrap network failure", async () => {
    const { cwd, profile } = setupAntigravityBin([
      "#!/bin/sh",
      "count=0",
      "test -f retry-count && count=$(/bin/cat retry-count)",
      "count=$((count + 1))",
      "printf '%s' \"$count\" > retry-count",
      "if test \"$count\" -lt 3; then",
      "  printf '%s\\n' '{\"event\":\"result\",\"result\":{\"conversation_id\":\"\",\"status\":\"ERROR\",\"error\":\"Eligibility check failed: failed to get profile picture: dial tcp: i/o timeout\",\"num_turns\":0}}'",
      "  exit 1",
      "fi",
      "printf '%s\\n' '{\"event\":\"result\",\"result\":{\"conversation_id\":\"session-1\",\"status\":\"SUCCESS\",\"response\":\"Done.\\nINTER_RESULT: completed\",\"num_turns\":1}}'",
      "",
    ].join("\n"));
    const task = await delegate(profile.id, "do work", cwd);
    await waitForAttention(task.id);
    expect(getTask(task.id)).toMatchObject({ state: "completed" });
    expect(readFileSync(join(cwd, "retry-count"), "utf8")).toBe("3");
    expect(stateStore().listTaskEvents(task.id).filter((event) => event.type === "provider_retry"))
      .toHaveLength(2);
  });

  integrationTest("names the structural limitation when a custom-command profile resumes", async () => {
    const { cwd, profile } = setup(["/bin/sh", "-c", "echo broken; exit 1"]);
    const task = await delegate(profile.id, "do work", cwd, undefined, undefined, {
      scope: { read: [], write: [] },
    });
    await waitForAttention(task.id);
    expect(getTask(task.id)?.state).toBe("failed");
    await expect(resumeTask(task.id)).rejects.toThrow(
      /custom command; provider sessions are never captured/,
    );
  });

  integrationTest("answers in the same task and provider session", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "$(dirname "$0")/../argv.log"`,
      'case "$*" in',
      "  *--resume*)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"Finished.\\nINTER_RESULT: completed"}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"INTER_NEEDS_INPUT: Which file should I write?"}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const parent = await delegate(profile.id, "Write the selected file.", cwd);
    const first = await waitForAttention(parent.id);
    expect(first.tasks[0]).toMatchObject({
      state: "needs_input",
      question: "Which file should I write?",
    });
    expect(getTask(parent.id)?.sessionId).toBe("sess-1");

    const continued = await reply(parent.id, "docs/result.md");
    expect(continued.id).toBe(parent.id);
    const second = await waitForAttention(parent.id);
    expect(second.tasks[0]).toMatchObject({ state: "completed", output: "Finished." });
    expect(getTask(parent.id)?.sessionId).toBe("sess-1");
    const spawns = stateStore().listTaskEvents(parent.id).filter(({ type }) => type === "worker_spawned");
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.payload.resumedSession).toBe("sess-1");
    // argv entries span lines (the prompt embeds newlines), so count spawn
    // markers rather than log lines.
    const log = readFileSync(join(cwd, "argv.log"), "utf8");
    expect(log.split("--output-format").length - 1).toBe(2);
    expect(log).toContain("--resume sess-1");
    expect(log.indexOf("--resume")).toBe(log.lastIndexOf("--resume"));
  });

  integrationTest("reply with a scope replaces the task scope and becomes the grant", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "$(dirname "$0")/../argv.log"`,
      'case "$*" in',
      "  *--resume*)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"Finished.\\nINTER_RESULT: completed"}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"INTER_NEEDS_INPUT: Expand the write scope?"}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const parent = await delegate(profile.id, "Do the work.", cwd);
    await waitForAttention(parent.id);

    const continued = await reply(parent.id, "docs/**", {
      scope: { read: ["docs/**"], write: ["docs/**"] },
    });
    expect(continued.scope).toEqual({ read: ["docs/**"], write: ["docs/**"] });
    expect(continued.grantId).toBeDefined();
    expect(stateStore().latestScopeGrant(cwd, profile.id)?.id).toBe(continued.grantId);

    const result = await waitForAttention(parent.id);
    expect(result.tasks[0]).toMatchObject({ state: "completed" });
  });

  integrationTest("reply without a scope leaves the existing task scope untouched", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      'case "$*" in',
      "  *--resume*)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"Finished.\\nINTER_RESULT: completed"}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"INTER_NEEDS_INPUT: Continue?"}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const parent = await delegate(profile.id, "Do the work.", cwd);
    await waitForAttention(parent.id);

    await reply(parent.id, "yes");
    const kept = getTask(parent.id);
    expect(kept?.scope).toEqual({ read: ["**"], write: ["**"] });
    expect(kept?.grantId).toBeUndefined();

    const result = await waitForAttention(parent.id);
    expect(result.tasks[0]).toMatchObject({ state: "completed" });
  });

  integrationTest("fails if a provider forks instead of reusing the captured session", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      'case "$*" in',
      "  *--resume*)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-new"}'`,
      "    sleep 5",
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-old"}'`,
      `    printf '%s\\n' '{"type":"result","result":"INTER_NEEDS_INPUT: Proceed?"}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const task = await delegate(profile.id, "Do the work.", cwd);
    await waitForAttention(task.id);

    expect((await reply(task.id, "yes")).id).toBe(task.id);
    const result = await waitForAttention(task.id);
    expect(result.tasks[0]).toMatchObject({
      state: "failed",
      sessionId: "sess-old",
      error: "provider resumed a different root session",
    });
    expect(stateStore().listTaskEvents(task.id).map(({ type }) => type))
      .toContain("resume_session_mismatch");
  });

  integrationTest("fails rather than losing context when the session cannot resume", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      'case "$*" in',
      "  *--resume*) exit 7 ;;",
      '  *"# Resolved decision"*)',
      `    printf '%s\\n' '{"type":"system","session_id":"sess-fresh"}'`,
      `    printf '%s\\n' '{"type":"result","result":"Recovered.\\nINTER_RESULT: completed"}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `    printf '%s\\n' '{"type":"result","result":"INTER_NEEDS_INPUT: Proceed how?"}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const parent = await delegate(profile.id, "Do the work.", cwd);
    await waitForAttention(parent.id);
    expect(getTask(parent.id)?.sessionId).toBe("sess-1");

    const continued = await reply(parent.id, "carefully");
    expect(continued.id).toBe(parent.id);
    const result = await waitForAttention(parent.id);
    expect(result.tasks[0]).toMatchObject({ state: "failed" });
    const types = stateStore().listTaskEvents(parent.id).map(({ type }) => type);
    expect(types.filter((type) => type === "worker_spawned")).toHaveLength(2);
    expect(types).toContain("resume_failed");
  });

  integrationTest("resumes a failed task in its captured worker session", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      "case \"$*\" in",
      "  *--resume*)",
      "    printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"sess-failed\",\"result\":\"Done.\\nINTER_RESULT: completed\"}'",
      "    exit 0",
      "    ;;",
      "esac",
      "printf '%s\\n' '{\"type\":\"system\",\"session_id\":\"sess-failed\"}'",
      "printf '%s\\n' 'worker crashed' >&2",
      "exit 1",
    ].join("\n"));
    const failed = await delegate(profile.id, "do work", cwd, undefined, undefined, {
      scope: { read: [], write: [] },
      timeoutMs: 15_000,
    });
    await waitForAttention(failed.id);
    expect(getTask(failed.id)).toMatchObject({ state: "failed", sessionId: "sess-failed" });

    const resumed = await resumeTask(failed.id, "Finish the remaining work.", {
      timeoutMs: 5_000,
      scope: { read: ["**"], write: ["**"] },
      allowQuestions: false,
    });
    expect(resumed.timeoutMs).toBe(5_000);
    expect(resumed.scope).toEqual({ read: ["**"], write: ["**"] });
    expect(resumed.allowQuestions).toBe(false);
    expect(resumed.id).toBe(failed.id);
    await waitForAttention(resumed.id);
    expect(getTask(failed.id)).toMatchObject({ state: "completed", sessionId: "sess-failed" });
    const events = stateStore().listTaskEvents(failed.id);
    expect(events.filter(({ type }) => type === "worker_spawned")).toHaveLength(2);
    expect(events.filter(({ type }) => type === "session_reused")).toHaveLength(1);
  });

  // The broker inherits PWD from whatever shell launched the app. A worker that
  // trusts PWD over getcwd would read that directory, which the sandbox denies,
  // so the task directory has to be the only one the worker can see.
  integrationTest("names the task directory as the worker's only cwd", async () => {
    const { cwd, profile } = setup([
      "/bin/sh",
      "-c",
      'printf "%s\\n%s" "$PWD" "$(pwd -P)" > pwd.txt; printf "INTER_RESULT: completed\\n"',
    ]);
    const previousPwd = process.env.PWD;
    process.env.PWD = "/Users/nobody/some-other-checkout";
    try {
      const task = await delegate(profile.id, "record cwd", cwd, undefined, undefined, {
        scope: { read: [], write: ["pwd.txt"] },
      });
      await waitForAttention(task.id);
      expect(getTask(task.id)).toMatchObject({ state: "completed" });
      const [announced, actual] = readFileSync(join(cwd, "pwd.txt"), "utf8").split("\n");
      expect(announced).toBe(cwd);
      expect(actual).toBe(realpathSync(cwd));
    } finally {
      if (previousPwd === undefined) delete process.env.PWD;
      else process.env.PWD = previousPwd;
    }
  });
});
