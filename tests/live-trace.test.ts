import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import type { Profile, Task } from "../src/types";

/**
 * The app-live-trace rewrite, Leg A surface: summary state, single-task
 * detail, and event tail paging. Test files share one process, so the broker
 * cannot be imported here — cli-surface.test.ts already evaluated src/cli.ts,
 * whose port and store were claimed by that suite. Instead the broker runs as
 * a subprocess over this file's own database (the watch-socket pattern); the
 * store stays in-process for seeding and both sides read the same file.
 */
let root: string;
let base: string;
let broker: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
let profileId = "live-fake";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

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

/** Fill a trace with `count` rows after the automatic "created" event. */
function appendTrace(taskId: string, count: number, state: Task["state"] = "running"): void {
  for (let i = 0; i < count; i++) {
    stateStore().appendTaskEvent(taskId, "agent.event", state, {});
  }
}

function ascending(ids: number[]): boolean {
  return ids.every((id, i) => i === 0 || id > ids[i - 1]);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "inter-live-trace-"));
  // A previous suite in this process may have left the store singleton open on
  // its own database; claim it fresh for this file's db, then seed the profile
  // the broker will serve (its loadConfig reads this same store).
  closeStateStore();
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  seedProfile({
    id: profileId,
    label: "Live Fake",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
    command: ["/bin/sh", "-c", "echo hi"],
  });
  // Grab a free port, then hand it to the broker subprocess before it binds.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = probe.port;
  probe.stop();
  broker = Bun.spawn(["bun", "run", CLI, "serve"], {
    env: { ...process.env, INTER_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // Not up yet; try again.
    }
    await Bun.sleep(50);
  }
  throw new Error(`broker subprocess never came up\n${await new Response(broker.stderr).text()}`);
});

afterAll(() => {
  broker.kill();
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_ROOTS;
  delete process.env.INTER_PORT;
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/state?view=summary", () => {
  test("summary rows carry no prompt, output, or attempts", async () => {
    const seeded = seedTask({
      prompt: "first line\nsecond line",
      output: "out",
      sessionId: "sess-summary",
    });
    const response = await fetch(`${base}/api/state?view=summary&archived=include`);
    expect(response.status).toBe(200);
    const body = await response.json();
    // Same envelope as today — only the task rows slim down.
    expect(Object.keys(body).sort()).toEqual([
      "grants", "memoryProjects", "profileFailures", "profiles", "tasks",
    ]);
    const row = body.tasks.find((item: { id: string }) => item.id === seeded.id);
    expect(row.promptPreview).toBe("first line second line");
    expect(row.prompt).toBeUndefined();
    expect(row.output).toBeUndefined();
    expect(row.attempts).toBeUndefined();
    expect(row.sessionId).toBeUndefined();
    // The same poll without the view is byte-for-byte the full row.
    const fullBody = await (await fetch(`${base}/api/state?archived=include`)).json();
    const fullRow = fullBody.tasks.find((item: { id: string }) => item.id === seeded.id);
    expect(fullRow.prompt).toBe("first line\nsecond line");
    expect(fullRow.output).toBe("out");
    expect(fullRow.sessionId).toBe("sess-summary");
  });

  test("the archived filter still applies in summary view", async () => {
    const active = seedTask({});
    const archived = seedTask({});
    stateStore().setTaskArchived(archived.id, true);
    const activeBody = await (await fetch(`${base}/api/state?view=summary`)).json();
    const ids = activeBody.tasks.map((item: { id: string }) => item.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
    const onlyBody = await (await fetch(`${base}/api/state?view=summary&archived=only`)).json();
    expect(onlyBody.tasks.map((item: { id: string }) => item.id)).toEqual([archived.id]);
  });
});

describe("GET /api/tasks/:id", () => {
  test("returns the full row, sessionId included", async () => {
    const seeded = seedTask({ output: "out", sessionId: "sess-detail" });
    const response = await fetch(`${base}/api/tasks/${seeded.id}`);
    expect(response.status).toBe(200);
    // The exact row /api/state tasks have today — same store read, same shape.
    expect(await response.json()).toEqual(stateStore().getTask(seeded.id));
    expect(seeded.sessionId).toBe("sess-detail");
  });

  test("404s on an unknown id", async () => {
    const response = await fetch(`${base}/api/tasks/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown task" });
  });

  test("does not shadow the /events or /resume subroutes", async () => {
    const seeded = seedTask({ output: "shadow-out" });
    const events = await (await fetch(`${base}/api/tasks/${seeded.id}/events`)).json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe("lifecycle");
    expect(events[0].id).toBeGreaterThan(0);
    expect((events[0] as Record<string, unknown>).prompt).toBeUndefined();
    const resume = await fetch(`${base}/api/tasks/${seeded.id}/resume`, { method: "POST", body: "" });
    expect(resume.status).toBe(400);
    expect((await resume.json()).error).toContain("cannot be resumed");
  });
});

describe("event tail paging", () => {
  test("bare ?last returns the newest N, ascending, with oldestId and hasEarlier", async () => {
    const seeded = seedTask({ state: "running" });
    appendTrace(seeded.id, 5); // 6 events total (the automatic "created" first)
    const whole = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=99`)).json();
    expect(whole.events.length).toBe(6);
    expect(whole.hasEarlier).toBe(false);
    const all = whole.events.map((event: { id: number }) => event.id);
    const page = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=3`)).json();
    const ids = page.events.map((event: { id: number }) => event.id);
    expect(ascending(ids)).toBe(true);
    expect(ids).toEqual(all.slice(3)); // the newest three
    expect(page.oldestId).toBe(ids[0]);
    expect(page.cursor).toBe(ids[2]);
    expect(page.hasMore).toBe(false);
    expect(page.hasEarlier).toBe(true);
    // Paging back from the head: exactly the older rows, and hasEarlier flips.
    const head = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=99&before=${ids[0]}`)).json();
    expect(head.events.map((event: { id: number }) => event.id)).toEqual(all.slice(0, 3));
    expect(head.hasEarlier).toBe(false);
    expect(head.oldestId).toBe(all[0]);
  });

  test("last clamps into [1, 5000]", async () => {
    const seeded = seedTask({ state: "running" });
    appendTrace(seeded.id, 5_010); // 5,011 events total
    const big = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=99999`)).json();
    expect(big.events.length).toBe(5_000);
    expect(big.hasEarlier).toBe(true);
    const small = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=0`)).json();
    expect(small.events.length).toBe(1);
    expect(small.hasEarlier).toBe(true);
  });

  test("before pages backward to the head without overlap", async () => {
    const seeded = seedTask({ state: "running" });
    appendTrace(seeded.id, 7); // 8 events total
    const first = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=3`)).json();
    const second = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=3&before=${first.oldestId}`)).json();
    const third = await (await fetch(`${base}/api/tasks/${seeded.id}/events?last=3&before=${second.oldestId}`)).json();
    for (const page of [first, second, third]) {
      expect(ascending(page.events.map((event: { id: number }) => event.id))).toBe(true);
    }
    expect(second.events.every((event: { id: number }) => event.id < first.oldestId)).toBe(true);
    expect(third.events.every((event: { id: number }) => event.id < second.oldestId)).toBe(true);
    const seen = new Set(
      [...first.events, ...second.events, ...third.events].map((event: { id: number }) => event.id),
    );
    expect(seen.size).toBe(8); // the whole trace, every event exactly once
    expect(first.hasEarlier).toBe(true);
    expect(second.hasEarlier).toBe(true);
    expect(third.hasEarlier).toBe(false); // head reached
  });

  test("waitMs is ignored when last is present", async () => {
    const seeded = seedTask({ state: "running" });
    appendTrace(seeded.id, 4);
    const latest = stateStore().latestTaskEventId([seeded.id]);
    const started = Date.now();
    // after=latest&waitMs=2000 would block the long-poll for the full 2s; a
    // tail read must answer immediately instead.
    const response = await fetch(`${base}/api/tasks/${seeded.id}/events?after=${latest}&waitMs=2000&last=2`);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    const body = await response.json();
    expect(body.events.map((event: { id: number }) => event.id)).toEqual([latest - 1, latest]);
    expect(body.hasEarlier).toBe(true);
  });

  test("the legacy after+waitMs envelope is unchanged", async () => {
    const seeded = seedTask({ state: "completed" });
    appendTrace(seeded.id, 4); // 5 events total
    const all = await (await fetch(`${base}/api/tasks/${seeded.id}/events?after=0&waitMs=0`)).json();
    expect(Object.keys(all).sort()).toEqual(["cursor", "events", "hasMore"]);
    expect(all.hasMore).toBe(false);
    expect(all.events.length).toBe(5);
    const ids = all.events.map((event: { id: number }) => event.id);
    expect(ascending(ids)).toBe(true);
    expect(all.cursor).toBe(ids[4]);
    const partial = await (await fetch(`${base}/api/tasks/${seeded.id}/events?after=${ids[2]}`)).json();
    expect(partial.events.map((event: { id: number }) => event.id)).toEqual(ids.slice(3));
    // No params at all: still the bare array.
    const bare = await (await fetch(`${base}/api/tasks/${seeded.id}/events`)).json();
    expect(Array.isArray(bare)).toBe(true);
  });
});
