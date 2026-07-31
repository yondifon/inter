import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      state: "cancelled",
      completion: { code: "timeout" },
    });
  });

  integrationTest("answers in the same task and provider session", async () => {
    const { cwd, profile } = setupClaudeBin([
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "$(dirname "$0")/../argv.log"`,
      'case "$*" in',
      "  *--resume*)",
      `    printf '%s\\n' '{"type":"system","session_id":"sess-2"}'`,
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
    expect(getTask(parent.id)?.sessionId).toBe("sess-2");
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
    });
    await waitForAttention(failed.id);
    expect(getTask(failed.id)).toMatchObject({ state: "failed", sessionId: "sess-failed" });

    const resumed = await resumeTask(failed.id, "Finish the remaining work.");
    await waitForAttention(resumed.id);
    expect(getTask(resumed.id)).toMatchObject({ state: "completed", parentTaskId: failed.id });
    expect(getTask(failed.id)?.childTaskId).toBe(resumed.id);
  });
});
