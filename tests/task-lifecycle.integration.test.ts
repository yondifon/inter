import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cancelTask, delegate, getTask, reply, waitForTasks } from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile } from "../src/types";

const integrationTest = process.env.INTER_SANDBOX_INTEGRATION === "1" ? test : test.skip;
const roots: string[] = [];

afterEach(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_CONFIG;
  delete process.env.INTER_ROOTS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(command: string[]): { cwd: string; profile: Profile } {
  const root = mkdtempSync(join(tmpdir(), "inter-lifecycle-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_CONFIG = join(root, "missing.json");
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

  integrationTest("answers a worker question and closes the parent", async () => {
    const script = [
      "case \"$1\" in",
      "  *\"# Resolved decision\"*) printf 'Finished.\\nINTER_RESULT: completed\\n' ;;",
      "  *) printf 'INTER_NEEDS_INPUT: Which file should I write?\\n' ;;",
      "esac",
    ].join("\n");
    const { cwd, profile } = setup(["/bin/sh", "-c", script, "inter", "{prompt}"]);
    const parent = await delegate(profile.id, "Write the selected file.", cwd, undefined, undefined, {
      scope: { read: [], write: [] },
    });
    const first = await waitForAttention(parent.id);
    expect(first.tasks[0]).toMatchObject({
      state: "needs_input",
      question: "Which file should I write?",
    });

    const child = await reply(parent.id, "docs/result.md");
    const second = await waitForAttention(child.id);
    expect(second.tasks[0]).toMatchObject({ state: "completed", output: "Finished." });
    expect(getTask(parent.id)).toMatchObject({
      state: "answered",
      childTaskId: child.id,
    });
  });
});
