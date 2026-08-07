import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import * as realTaskScope from "../src/task-scope";
import * as realAdapters from "../src/adapters";

// Captured before the mock registers: a bare function reference stays bound to
// the real implementation, where a namespace lookup through a mocked module
// can bounce back into the mock.
const realCommandFor = realAdapters.commandFor;
const realResumeCommandFor = realAdapters.resumeCommandFor;
const realCanResumeSession = realAdapters.canResumeSession;

// Same discipline as tasks-capture.test.ts: sandbox-exec cannot nest inside
// this sandboxed runner, so only the wrapper is replaced; the worker itself
// still runs as a real subprocess. The provider CLI is replaced too — the
// fake command emits the opencode session line, so the real sessionIdFrom
// captures the session and reply/resume reopen it.
mock.module("../src/task-scope", () => ({
  ...realTaskScope,
  sandboxedCommand: (command: string[]) => command,
}));
mock.module("../src/adapters", () => ({
  ...realAdapters,
  commandFor: fakeCommand,
  resumeCommandFor: fakeResumeCommand,
  canResumeSession: fakeCanResumeSession,
}));

const { delegate, getTask, handoffTask, reply, resumeTask } = await import("../src/tasks");
const { closeStateStore, stateStore } = await import("../src/store");
import { buildContextMap, pendingContextJobs } from "../src/context-map";
import type { Profile, Task } from "../src/types";

const ALPHA_TS = "export function alpha(x: number) { return x }\nfunction beta() {}\n";

// bun test runs every file in one process, so a wholesale adapters mock would
// leak into adapters.test.ts and tasks-capture.test.ts. The mock is therefore
// conditional: only the fake profiles get the fake commands, every other
// profile sees the real adapters, so the rest of the suite is untouched.
const FAKE_PROFILES = new Set(["resumable-fake", "beta"]);

/**
 * The resume path is the only caller that passes a session id, so rest[0] —
 * the model on a fresh run, the session id on a resumed one — picks which
 * script the reply test's second run gets. Every other test fixes one script
 * for both runs.
 */
let script = "";
let resumedScript: string | undefined;

function fakeCommand(
  profile: Profile,
  prompt: string,
  cwd: string,
  model?: string,
  hookUrl?: string,
  effort?: string,
): string[] {
  if (!FAKE_PROFILES.has(profile.id)) {
    return realCommandFor(profile, prompt, cwd, model, hookUrl, effort);
  }
  return ["/bin/sh", "-c", script];
}

function fakeResumeCommand(
  profile: Profile,
  prompt: string,
  cwd: string,
  sessionId: string,
  model?: string,
  hookUrl?: string,
  effort?: string,
): string[] {
  if (!FAKE_PROFILES.has(profile.id)) {
    return realResumeCommandFor(profile, prompt, cwd, sessionId, model, hookUrl, effort);
  }
  return ["/bin/sh", "-c", sessionId === "sess-1" && resumedScript ? resumedScript : script];
}

function fakeCanResumeSession(profile: Profile): boolean {
  return FAKE_PROFILES.has(profile.id) ? true : realCanResumeSession(profile);
}

function line(text: string): string {
  return `printf '%s\n' '${text}'`;
}

const SESSION_LINE = line('{"type":"step_start","sessionID":"sess-1"}');
const COMPLETE = `echo "INTER_RESULT: completed"`;
const NEEDS_INPUT = `echo "INTER_NEEDS_INPUT: what color?"`;
const FAIL = [`echo "boom"`, `exit 2`];

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "inter-map-ship-"));
  scratch.push(dir);
  process.env.INTER_DB = join(dir, "inter.db");
  process.env.INTER_ROOTS = dir;
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function seedProfiles(): void {
  stateStore().saveProfiles([
    { id: "resumable-fake", label: "Resumable Fake", provider: "opencode", model: "fake", enabled: true, env: {}, capabilities: [] },
    { id: "beta", label: "Beta", provider: "opencode", model: "fake", enabled: true, env: {}, capabilities: [] },
  ]);
}

async function settled(id: string, attempts = 200): Promise<Task> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const task = getTask(id);
    if (task && !["queued", "running"].includes(task.state)) return task;
    await Bun.sleep(25);
  }
  throw new Error(`task never settled: ${id}`);
}

const savedRoots = process.env.INTER_ROOTS;
const savedDb = process.env.INTER_DB;
const scratch: string[] = [];

beforeEach(() => {
  resumedScript = undefined;
});

afterEach(async () => {
  // The settle queued a context fold; let it finish before the store closes.
  await Promise.all(pendingContextJobs());
  closeStateStore();
  if (savedRoots === undefined) delete process.env.INTER_ROOTS;
  else process.env.INTER_ROOTS = savedRoots;
  if (savedDb === undefined) delete process.env.INTER_DB;
  else process.env.INTER_DB = savedDb;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shipped Project map block", () => {
  test("delegate ships the block with the file detail and the lookup instruction", async () => {
    const root = project({ "src/a.ts": ALPHA_TS });
    seedProfiles();
    script = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work on src/a.ts", root, "fake");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const shipped = getTask(task.id)!.shippedPrompt!;
    expect(shipped).toContain("## Project map");
    expect(shipped).toContain("### src/a.ts · ");
    expect(shipped).toContain("curl -s");
  });

  test("reply re-ships the block in the same session", async () => {
    const root = project({ "src/a.ts": ALPHA_TS });
    seedProfiles();
    script = [SESSION_LINE, NEEDS_INPUT].join("; ");
    resumedScript = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const asked = await settled(task.id);
    expect(asked.state).toBe("needs_input");
    await reply(task.id, "blue");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    expect(stateStore().listTaskEvents(task.id).some(({ type }) => type === "session_reused")).toBe(true);
    expect(getTask(task.id)!.shippedPrompt).toContain("## Project map");
  });

  test("resume re-ships the block", async () => {
    const root = project({ "src/a.ts": ALPHA_TS });
    seedProfiles();
    script = [SESSION_LINE, ...FAIL].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const failed = await settled(task.id);
    expect(failed.state).toBe("failed");
    await resumeTask(task.id);
    const done = await settled(task.id);
    expect(done.state).toBe("failed");
    expect(getTask(task.id)!.shippedPrompt).toContain("## Project map");
  });

  test("handoff ships the brief and the block", async () => {
    const root = project({ "src/a.ts": ALPHA_TS });
    seedProfiles();
    script = [SESSION_LINE, ...FAIL].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    await settled(task.id);
    await handoffTask(task.id, "beta");
    const done = await settled(task.id);
    expect(done.state).toBe("failed");
    const shipped = getTask(task.id)!.shippedPrompt!;
    expect(shipped).toContain("## Project map");
    expect(shipped).toContain("# Original task");
  });

  test("ship = false suppresses the block but not the dispatch", async () => {
    const root = project({ "src/a.ts": ALPHA_TS, ".inter.toml": "[map]\nship = false\n" });
    seedProfiles();
    script = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    expect(getTask(task.id)!.shippedPrompt).not.toContain("## Project map");
  });

  test("a corrupt map row never fails a dispatch", async () => {
    const root = project({ "src/a.ts": ALPHA_TS });
    seedProfiles();
    buildContextMap(root);
    const raw = new Database(process.env.INTER_DB!);
    raw.run("PRAGMA ignore_check_constraints = ON");
    raw.run("UPDATE context_files SET symbols_json = '{' WHERE path = 'src/a.ts'");
    raw.close();
    script = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    expect(getTask(task.id)!.shippedPrompt).toContain("## Project map");
  });

  test("no map rows ships the header and instruction only", async () => {
    const root = project();
    seedProfiles();
    script = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const shipped = getTask(task.id)!.shippedPrompt!;
    expect(shipped).toContain("## Project map");
    expect(shipped).toContain("0 files");
  });

  test("an unparseable file ships its marker and never fails a dispatch", async () => {
    const root = project({ "src/broken.ts": "function broken( {\n" });
    seedProfiles();
    script = [SESSION_LINE, COMPLETE].join("; ");

    const task = await delegate("resumable-fake", "work", root, "fake");
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    expect(getTask(task.id)!.shippedPrompt).toContain("(symbols unavailable)");
  });
});
