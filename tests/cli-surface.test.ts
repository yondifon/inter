import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile, Task } from "../src/types";

/**
 * The HTTP surface lives inside Bun.serve's fetch handler with no seam (review
 * finding 1), so the only way to exercise it is through the real listener:
 * point INTER_PORT at a free port, start the broker, and fetch. Each test file
 * runs in its own process, so this listener binds no other suite's port.
 */
let root: string;
let base: string;
let taskId: string;
let profileId = "surface-fake";
let tasksToolQuerySchema: typeof import("../src/cli").tasksToolQuerySchema;
let archiveTaskIdSchema: typeof import("../src/cli").archiveTaskIdSchema;
let cancelTaskIdSchema: typeof import("../src/cli").cancelTaskIdSchema;

const mask = "••••••••";

function seedProfile(profile: Profile): void {
  stateStore().saveProfiles([profile]);
}

function seedTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId,
    model: "fake",
    prompt: "seed",
    cwd: root,
    state: "completed",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: [root], write: [root] },
    allowQuestions: true,
    ...overrides,
  };
  stateStore().createTask(task);
  return task;
}

function post(path: string, body: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function put(path: string, body: string) {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "inter-surface-"));
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  // Grab a free port, then hand it to the module before it reads it at import.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = probe.port;
  probe.stop();
  process.env.INTER_PORT = String(port);
  const cli = await import("../src/cli");
  tasksToolQuerySchema = cli.tasksToolQuerySchema;
  archiveTaskIdSchema = cli.archiveTaskIdSchema;
  cancelTaskIdSchema = cli.cancelTaskIdSchema;
  cli.startBroker();
  base = `http://127.0.0.1:${port}`;
  seedProfile({
    id: profileId,
    label: "Surface Fake",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: { ANTHROPIC_API_KEY: "s3cr3t" },
    capabilities: [],
    // The sandbox in this environment refuses nested sandbox-exec, so the
    // worker dies instantly; the route's 202 contract does not depend on it.
    command: ["/bin/sh", "-c", "echo hi"],
  });
  taskId = seedTask().id;
});

afterAll(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_ROOTS;
  delete process.env.INTER_PORT;
  rmSync(root, { recursive: true, force: true });
});

describe("malformed JSON is a 400, not a 500", () => {
  test.each([
    ["POST /api/tasks", () => post("/api/tasks", "{")],
    ["POST /api/profiles", () => post("/api/profiles", "{")],
    ["PUT /api/profiles/:id", () => put(`/api/profiles/${profileId}`, "{")],
    ["PATCH /api/tasks/:id", () => fetch(`${base}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    })],
    ["POST /api/hooks/:id", () => post(`/api/hooks/${taskId}`, "{")],
    ["POST /api/tasks/:id/resume", () => post(`/api/tasks/${taskId}/resume`, "{")],
  ])("%s", async (_name, request) => {
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });
});

describe("invalid bodies are a 400 with a useful message", () => {
  test("null task body names the problem instead of a TypeError", async () => {
    const response = await post("/api/tasks", "null");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("expected object");
  });

  test("a wrong prompt type points at the field", async () => {
    const response = await post("/api/tasks", JSON.stringify({
      profile: profileId, prompt: 42, cwd: root,
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("prompt:");
    expect(body.error).toContain("expected string");
  });

  test("the string \"false\" no longer enables questions", async () => {
    const response = await post("/api/tasks", JSON.stringify({
      profile: profileId, prompt: "hi", cwd: root, allowQuestions: "false",
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("allowQuestions:");
  });

  test("a prompt over the MCP cap is rejected", async () => {
    const response = await post("/api/tasks", JSON.stringify({
      profile: profileId, prompt: "x".repeat(64_001), cwd: root,
    }));
    expect(response.status).toBe(400);
  });

  test("profile creation surfaces its own validation messages", async () => {
    const badProvider = await post("/api/profiles", JSON.stringify({
      provider: "bogus", label: "Nope",
    }));
    expect(badProvider.status).toBe(400);
    expect((await badProvider.json()).error).toContain("invalid provider");

    const noLabel = await post("/api/profiles", JSON.stringify({ provider: "pi" }));
    expect(noLabel.status).toBe(400);
    expect((await noLabel.json()).error).toContain("label is required");
  });

  test("a profile patch env array is rejected, not written as key \"0\"", async () => {
    const response = await put(`/api/profiles/${profileId}`, JSON.stringify({ env: ["a"] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("env:");
  });

  test("a blank profile label is rejected", async () => {
    const response = await put(`/api/profiles/${profileId}`, JSON.stringify({ label: "" }));
    expect(response.status).toBe(400);
  });

  test("an unknown profile provider is rejected", async () => {
    const response = await put(`/api/profiles/${profileId}`, JSON.stringify({ provider: "bogus" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("provider:");
  });

  test("an oversized profile model is rejected", async () => {
    const response = await put(`/api/profiles/${profileId}`, JSON.stringify({
      model: "m".repeat(201),
    }));
    expect(response.status).toBe(400);
  });

  test("a non-boolean archived flag is rejected", async () => {
    const response = await fetch(`${base}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: "yes" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("archived:");
  });
});

describe("valid bodies still succeed", () => {
  test("POST /api/tasks dispatches and returns the acknowledgement", async () => {
    const response = await post("/api/tasks", JSON.stringify({
      profile: profileId,
      prompt: "do the thing",
      cwd: root,
      scope: { read: [], write: [] },
      allowQuestions: false,
      tldr: "a short summary",
      title: "Do the thing",
    }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.id).toBe("string");
    expect(body.profileId).toBe(profileId);
    // runTask flips the row to "running" asynchronously and mutates the task
    // object in place, so either is a valid view of the same dispatch.
    expect(["queued", "running"]).toContain(body.state);
    const row = stateStore().getTask(body.id);
    expect(row?.title).toBe("Do the thing");
    expect(row?.allowQuestions).toBe(false);
  });

  // After the dispatch test: this one disables the shared profile, and
  // delegate refuses a disabled profile.
  test("PUT /api/profiles/:id accepts the app's full-profile body and round-trips masked env", async () => {
    // The app PUTs the whole Profile it decoded from the state poll, masked
    // secrets included. The sentinel must keep the stored value, not overwrite it.
    const response = await put(`/api/profiles/${profileId}`, JSON.stringify({
      id: profileId,
      label: "Surface Renamed",
      provider: "antigravity",
      model: "other",
      enabled: false,
      env: { ANTHROPIC_API_KEY: mask },
      capabilities: ["review"],
      command: ["/bin/sh", "-c", "echo hi"],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.label).toBe("Surface Renamed");
    expect(body.enabled).toBe(false);
    const saved = stateStore().listProfiles().find((item) => item.id === profileId);
    expect(saved?.env.ANTHROPIC_API_KEY).toBe("s3cr3t");
    expect(saved?.model).toBe("other");
    expect(saved?.label).toBe("Surface Renamed");
  });

  test("PATCH /api/tasks/:id archives and the response carries archivedAt", async () => {
    const response = await fetch(`${base}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(taskId);
    expect(body.archivedAt).toBeDefined();
    expect(stateStore().getTask(taskId)?.archivedAt).toBeDefined();
  });

  test("POST /api/hooks/:id accepts an object payload and records the event", async () => {
    const response = await post(`/api/hooks/${taskId}`, JSON.stringify({ event: "x" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const events = stateStore().listTaskEvents(taskId);
    expect(events.at(-1)?.type).toBe("agent.hook");
  });

  test("POST /api/hooks/:id truncates an oversized payload instead of storing it whole", async () => {
    const response = await post(`/api/hooks/${taskId}`, JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: { content: "line of file content\n".repeat(6_000) },
    }));
    expect(response.status).toBe(200);
    const stored = stateStore().listTaskEvents(taskId).at(-1)!;
    expect(stored.type).toBe("agent.hook");
    const content = (stored.payload as { tool_response: { content: string } }).tool_response.content;
    expect(content).toContain("…[truncated: kept");
    expect(Buffer.byteLength(JSON.stringify(stored.payload))).toBeLessThan(6_000 * 21);
  });

  // Last: saveConfig replaces the whole profile list, so nothing that needs
  // the seeded surface-fake profile may run after it.
  test("POST /api/profiles returns 201 with the created profile", async () => {
    const response = await post("/api/profiles", JSON.stringify({
      label: "Surface Test",
      provider: "pi",
      env: { SOME_SECRET: "visible" },
      capabilities: ["build"],
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe("surface-test");
    expect(body.label).toBe("Surface Test");
    const saved = stateStore().listProfiles().find((item) => item.id === "surface-test");
    expect(saved?.env.SOME_SECRET).toBe("visible");
  });
});

describe("/api/state", () => {
  test("returns stored output verbatim instead of re-running finalText", async () => {
    // The stored output is already the parsed answer. Under the old mapping
    // this route re-extracted it: for a claude profile the final line parses
    // as {"result": "second"}, so the poll would report "second".
    // The profile row must exist before the task row references it.
    seedProfile({
      id: "state-claude",
      label: "State Claude",
      provider: "claude",
      model: "sonnet",
      enabled: true,
      env: {},
      capabilities: [],
    });
    const now = new Date().toISOString();
    const seeded = seedTask({
      id: "state-divergence",
      profileId: "state-claude",
      model: "sonnet",
      state: "completed",
      createdAt: now,
      updatedAt: now,
      output: "first\n{\"result\": \"second\"}",
    });
    const response = await fetch(`${base}/api/state?archived=include`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "grants", "memoryProjects", "profileFailures", "profiles", "spend", "tasks",
    ]);
    const task = body.tasks.find((item: { id: string }) => item.id === seeded.id);
    expect(task.output).toBe("first\n{\"result\": \"second\"}");
    expect(stateStore().getTask(seeded.id)?.output).toBe(task.output);
  });

  test("the summary view returns the same working set as the full view, not just 20 rows", async () => {
    for (let i = 0; i < 25; i++) seedTask({ id: `state-bulk-${i}` });
    const summaryBody = await (await fetch(`${base}/api/state?view=summary&archived=include`)).json();
    const fullBody = await (await fetch(`${base}/api/state?archived=include`)).json();
    expect(summaryBody.tasks.length).toBeGreaterThan(20);
    expect(summaryBody.tasks.length).toBe(fullBody.tasks.length);
  });
});

describe("the MCP tasks tool's input schema", () => {
  test("still refuses a limit above 100 and defaults to 20", () => {
    expect(tasksToolQuerySchema.parse({}).limit).toBe(20);
    expect(tasksToolQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(() => tasksToolQuerySchema.parse({ limit: 101 })).toThrow();
  });

  test("accepts the fields selector the other tools share", () => {
    expect(tasksToolQuerySchema.parse({}).fields).toBeUndefined();
    expect(tasksToolQuerySchema.parse({ fields: ["all"] }).fields).toEqual(["all"]);
    expect(tasksToolQuerySchema.parse({ fields: ["completion", "spend"] }).fields)
      .toEqual(["completion", "spend"]);
    expect(() => tasksToolQuerySchema.parse({ fields: ["prompt"] })).not.toThrow();
    expect(() => tasksToolQuerySchema.parse({ fields: ["nope"] })).toThrow();
  });

  test("accepts until and order, defaulting order to newest", () => {
    expect(tasksToolQuerySchema.parse({ until: "2026-08-05T00:00:00.000Z" }).until)
      .toBe("2026-08-05T00:00:00.000Z");
    expect(tasksToolQuerySchema.parse({}).order).toBe("newest");
    expect(tasksToolQuerySchema.parse({ order: "oldest" }).order).toBe("oldest");
  });

  test("refuses a non-ISO until the same way it refuses since", () => {
    expect(() => tasksToolQuerySchema.parse({ until: "yesterday" })).toThrow();
  });

  test("rejects until at or before since, naming both values", () => {
    expect(() => tasksToolQuerySchema.parse({
      since: "2026-08-05T00:00:00.000Z",
      until: "2026-08-05T00:00:00.000Z",
    })).toThrow(/until \(2026-08-05T00:00:00.000Z\) must be strictly after since \(2026-08-05T00:00:00.000Z\)/);
  });

  test("accepts a single state unchanged or an array meaning any-of", () => {
    expect(tasksToolQuerySchema.parse({ state: "completed" }).state).toBe("completed");
    expect(tasksToolQuerySchema.parse({ state: ["completed", "failed"] }).state)
      .toEqual(["completed", "failed"]);
  });

  test("refuses an empty array of states", () => {
    expect(() => tasksToolQuerySchema.parse({ state: [] })).toThrow();
  });

  test("refuses an unknown state inside an array", () => {
    expect(() => tasksToolQuerySchema.parse({ state: ["completed", "bogus"] })).toThrow();
  });
});

describe("the MCP archive tool's taskId schema", () => {
  test("accepts a single id unchanged", () => {
    expect(archiveTaskIdSchema.parse("task-1")).toBe("task-1");
  });

  test("accepts an array of ids", () => {
    expect(archiveTaskIdSchema.parse(["task-1", "task-2"])).toEqual(["task-1", "task-2"]);
  });

  test("refuses an empty array", () => {
    expect(() => archiveTaskIdSchema.parse([])).toThrow();
  });
});

describe("the MCP cancel tool's taskId schema", () => {
  test("accepts a single id unchanged", () => {
    expect(cancelTaskIdSchema.parse("task-1")).toBe("task-1");
  });

  test("accepts an array of ids", () => {
    expect(cancelTaskIdSchema.parse(["task-1", "task-2"])).toEqual(["task-1", "task-2"]);
  });

  test("refuses an empty array", () => {
    expect(() => cancelTaskIdSchema.parse([])).toThrow();
  });
});

describe("the build's own answer to /health", () => {
  test("/health reports the build's identity", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.mcpContractVersion).toBe("number");
    // The build stamp is what tells two same-version builds apart — the
    // comparison `make install` actually needs. "dev" under `bun run`; the
    // Makefile bakes a real sha+time stamp via --define.
    expect(body.build).toBe("dev");
    // Under `bun run` the running code is the source, so there is no older
    // build to be stale against.
    expect(body.stale).toBe(false);
  });

  // `make install` decides the running broker is the build it just made by
  // comparing these two strings, so the contract worth pinning is that they
  // are identical.
  test("the version subcommand prints exactly what /health serves", async () => {
    const health = await (await fetch(`${base}/health`)).text();
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), "version"], {
      env: { ...process.env, INTER_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(code).toBe(0);
    expect(stdout.trimEnd()).toBe(health.trimEnd());
  }, 30_000);
});
