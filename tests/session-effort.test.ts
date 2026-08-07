import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { sessionEffortFrom } from "../src/adapters";
import { recordActualEffort } from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OPENCODE_DB;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-effort-"));
  roots.push(root);
  return root;
}

const profile: Profile = {
  id: "worker",
  label: "Worker",
  provider: "opencode",
  model: "flash",
  enabled: true,
  env: {},
  capabilities: [],
};

function seedOpencodeDb(dataDir: string, sessions: Array<[string, string]>) {
  const dir = join(dataDir, "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT)");
  for (const [id, model] of sessions) {
    db.query("INSERT INTO session(id, model) VALUES (?, ?)").run(id, model);
  }
  db.close();
}

describe("sessionEffortFrom", () => {
  test("reads the actual variant from an opencode session", () => {
    const root = tempRoot();
    process.env.XDG_DATA_HOME = root;
    seedOpencodeDb(root, [["ses_1", '{"id":"flash","providerID":"opencode-go","variant":"max"}']]);
    expect(sessionEffortFrom("opencode", "ses_1", profile)).toBe("max");
  });

  test("reads the actual variant from the fallback opencode DB file", () => {
    const root = tempRoot();
    process.env.XDG_DATA_HOME = root;
    const dir = join(root, "opencode");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "opencode-next.db"));
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT)");
    db.query("INSERT INTO session(id, model) VALUES (?, ?)").run("ses_2", '{"id":"flash","providerID":"opencode-go","variant":"high"}');
    db.close();
    expect(sessionEffortFrom("opencode", "ses_2", profile)).toBe("high");
  });

  test("returns undefined when opencode has no session for the id", () => {
    const root = tempRoot();
    process.env.XDG_DATA_HOME = root;
    seedOpencodeDb(root, []);
    expect(sessionEffortFrom("opencode", "ses_missing", profile)).toBeUndefined();
  });

  test("returns undefined when opencode has no data directory at all", () => {
    const root = tempRoot();
    process.env.XDG_DATA_HOME = root;
    expect(sessionEffortFrom("opencode", "ses_1", profile)).toBeUndefined();
  });

  test("reads the last recorded thinking level from a pi session file", () => {
    const root = tempRoot();
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const dir = join(root, "--Users-malico-project--");
    mkdirSync(dir, { recursive: true });
    const id = "9f8c7b6a-5d4e-4f3a-9b2c-1d0e2f3a4b5c";
    writeFileSync(join(dir, `2026-08-07T12-00-00-000Z_${id}.jsonl`), [
      JSON.stringify({ type: "session", id, cwd: "/Users/malico/project" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max" }),
    ].join("\n"));
    expect(sessionEffortFrom("pi", id, profile)).toBe("max");
  });

  test("returns undefined for providers that do not record a reasoning level", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      expect(sessionEffortFrom(provider, "any-session", profile)).toBeUndefined();
    }
  });
});

describe("recordActualEffort", () => {
  function setup(): { cwd: string; store: typeof stateStore } {
    const root = tempRoot();
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    process.env.XDG_DATA_HOME = root;
    seedOpencodeDb(root, [["ses_1", '{"id":"flash","providerID":"opencode-go","variant":"high"}']]);
    stateStore().saveProfiles([profile]);
    return { cwd: root, store: stateStore };
  }

  function task(id: string, effort?: string, sessionId = "ses_1") {
    const now = new Date().toISOString();
    const store = stateStore();
    store.createTask({
      id,
      profileId: profile.id,
      model: "flash",
      prompt: "work",
      cwd: "/Users/malico/project",
      state: "running",
      output: "",
      scope: { read: ["**"], write: ["**"] },
      allowQuestions: true,
      createdAt: now,
      updatedAt: now,
      ...(effort ? { effort } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }

  test("stores the actual effort and warns when it differs from requested", () => {
    const { store } = setup();
    task("t1", "max");
    recordActualEffort(store().getTask("t1")!, { ...profile, provider: "opencode" });
    expect(store().getTask("t1")).toMatchObject({ effort: "max", effortActual: "high" });
    const events = store().listTaskEvents("t1");
    expect(events.at(-1)).toMatchObject({
      type: "effort_mismatch",
      payload: { requested: "max", actual: "high" },
    });
  });

  test("records the actual effort silently when it matches requested", () => {
    const { store } = setup();
    task("t2", "high");
    recordActualEffort(store().getTask("t2")!, { ...profile, provider: "opencode" });
    expect(store().getTask("t2")).toMatchObject({ effort: "high", effortActual: "high" });
    const types = store().listTaskEvents("t2").map(({ type }) => type);
    expect(types).not.toContain("effort_mismatch");
  });

  test("records the actual effort even when no effort was requested", () => {
    const { store } = setup();
    task("t3");
    recordActualEffort(store().getTask("t3")!, { ...profile, provider: "opencode" });
    expect(store().getTask("t3")).toMatchObject({ effortActual: "high" });
    const types = store().listTaskEvents("t3").map(({ type }) => type);
    expect(types).not.toContain("effort_mismatch");
  });

  test("leaves effortActual unknown for a provider that records no level", () => {
    const { store } = setup();
    task("t4", "max", "no-such-session");
    recordActualEffort(store().getTask("t4")!, { ...profile, provider: "claude" });
    expect(store().getTask("t4")).toMatchObject({ effort: "max" });
    expect(store().getTask("t4")).not.toHaveProperty("effortActual");
    const types = store().listTaskEvents("t4").map(({ type }) => type);
    expect(types).not.toContain("effort_mismatch");
  });

  test("skips entirely when the run captured no session", () => {
    const { store } = setup();
    task("t5", "max", "");
    recordActualEffort(store().getTask("t5")!, profile);
    expect(store().getTask("t5")).toMatchObject({ effort: "max" });
    expect(store().getTask("t5")).not.toHaveProperty("effortActual");
  });
});
