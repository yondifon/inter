import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { closeStateStore, stateStore } from "../src/store";
import { buildContextMap } from "../src/context-map";
import type { Task } from "../src/types";

/**
 * The map route lives in Bun.serve's fetch handler like every other HTTP
 * surface, so it is exercised through the real listener: INTER_PORT points at
 * a free port, the broker starts once, and each test swaps INTER_DB for its
 * own fresh project before the next request.
 */
const ALPHA_TS = "export function alpha(x: number) { return x }\nfunction beta() {}\n";
const APP_SWIFT = "public struct App {}\n";

let base: string;
let root: string;
const roots: string[] = [];

function scaffoldProject(): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), ALPHA_TS);
  mkdirSync(join(root, "swift", "Sources"), { recursive: true });
  writeFileSync(join(root, "swift", "Sources", "App.swift"), APP_SWIFT);
}

function seedProfile(): void {
  stateStore().saveProfiles([{
    id: "map-route",
    label: "Map Route",
    provider: "opencode",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
  }]);
}

function seedTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: "map-route",
    model: "fake",
    prompt: "seed",
    cwd: root,
    state: "completed",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    ...overrides,
  };
  stateStore().createTask(task);
  return task;
}

function mapUrl(taskId: string, params: string): string {
  return `${base}/api/map?task=${taskId}&${params}`;
}

const savedDb = process.env.INTER_DB;
const savedRoots = process.env.INTER_ROOTS;
const savedSock = process.env.INTER_SOCK;
let sockRoot: string;

beforeAll(async () => {
  // Grab a free port, then hand it to the module before it reads it at import.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = probe.port;
  probe.stop();
  // The port is passed explicitly: INTER_PORT is process-global, and another
  // broker-starting file in the same run owns it. The event socket needs its
  // own path too — its default resolves through the store, which refuses to
  // open the real broker's database from a test.
  sockRoot = mkdtempSync(join(tmpdir(), "ims-"));
  process.env.INTER_SOCK = join(sockRoot, "inter.sock");
  const cli = await import("../src/cli");
  cli.startBroker({ port });
  base = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  closeStateStore();
  root = mkdtempSync(join(tmpdir(), "inter-map-route-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
});

afterEach(() => {
  closeStateStore();
  if (savedDb === undefined) delete process.env.INTER_DB;
  else process.env.INTER_DB = savedDb;
  if (savedRoots === undefined) delete process.env.INTER_ROOTS;
  else process.env.INTER_ROOTS = savedRoots;
});

afterAll(() => {
  closeStateStore();
  delete process.env.INTER_PORT;
  if (savedSock === undefined) delete process.env.INTER_SOCK;
  else process.env.INTER_SOCK = savedSock;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(sockRoot, { recursive: true, force: true });
});

describe("GET /api/map", () => {
  test("an exact file path returns the full block and its symbols", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=src/a.ts&tier=full"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("# Context map —");
    expect(markdown).toContain("### src/a.ts · 2L · ");
    expect(markdown).toContain("- L1 fn alpha(x");
    expect(markdown).toContain("- L2 fn beta()");
  });

  test("a directory prefix returns skeletons without symbol lines", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=src/"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("### src/a.ts · 2L");
    expect(markdown).not.toContain("fn alpha");
  });

  test("repeatable path params return both files in one call", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=src/a.ts&path=swift/Sources/App.swift"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("### src/a.ts · 2L");
    expect(markdown).toContain("### swift/Sources/App.swift · 1L");
  });

  test("symbol queries match exact names and star prefixes", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const exact = await (await fetch(mapUrl(task.id, "symbol=alpha"), {
      headers: { accept: "application/json" },
    })).json();
    expect(exact.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts"]);

    const prefix = await (await fetch(mapUrl(task.id, "symbol=alph*"), {
      headers: { accept: "application/json" },
    })).json();
    expect(prefix.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts"]);

    const absent = await (await fetch(mapUrl(task.id, "symbol=nosuch"), {
      headers: { accept: "application/json" },
    })).json();
    expect(absent.files).toEqual([]);
  });

  test("an unknown task 404s; a missing task and missing selectors 400", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    expect((await fetch(`${base}/api/map?task=nosuch&path=src/a.ts`)).status).toBe(404);
    expect((await fetch(`${base}/api/map?path=src/a.ts`)).status).toBe(400);
    expect((await fetch(mapUrl(task.id, ""))).status).toBe(400);
  });

  test("an archived task 404s", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    stateStore().setTaskArchived(task.id, true);
    buildContextMap(root);

    expect((await fetch(mapUrl(task.id, "path=src/a.ts"))).status).toBe(404);
  });

  test("out-of-scope paths are omitted and counted", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask({ scope: { read: ["src/**"], write: [] } });
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=swift/"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("(1 path omitted: outside this task's read scope)");
    expect(markdown).not.toContain("App.swift");
  });

  test("a stale row is re-extracted on query", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);
    writeFileSync(join(root, "src", "a.ts"), "export function changed() {}\n");

    const response = await fetch(mapUrl(task.id, "path=src/a.ts&tier=full"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("- L1 fn changed()");
    expect(markdown).not.toContain("fn alpha");
  });

  test("a file gone from disk is omitted and counted", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);
    rmSync(join(root, "src", "a.ts"));

    const response = await fetch(mapUrl(task.id, "path=src/a.ts"));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("(1 path omitted: no longer on disk)");
  });

  test("accept: application/json returns markdown, files and omitted", async () => {
    scaffoldProject();
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=src/a.ts&tier=full"), {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(typeof body.markdown).toBe("string");
    expect(body.markdown).toContain("# Context map —");
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("src/a.ts");
    expect(body.files[0].symbols.map((symbol: { name: string }) => symbol.name)).toEqual(["alpha", "beta"]);
    expect(body.omitted).toEqual({ outsideScope: 0, gone: 0 });
  });

  test("[map] lookup = false 404s the route", async () => {
    scaffoldProject();
    writeFileSync(join(root, ".inter.toml"), "[map]\nlookup = false\n");
    seedProfile();
    const task = seedTask();
    buildContextMap(root);

    const response = await fetch(mapUrl(task.id, "path=src/a.ts"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "map lookup is disabled" });
  });

  test("a corrupt row is served with no symbols, never a 500", async () => {
    // The build skips a file with no symbols, so the raw INSERT below is the
    // only row for src/bad.ts; the parse guard must read it back as empty.
    scaffoldProject();
    writeFileSync(join(root, "src", "bad.ts"), "export {}\n");
    seedProfile();
    const task = seedTask();
    buildContextMap(root);
    const now = new Date().toISOString();
    const raw = new Database(process.env.INTER_DB!);
    raw.run("PRAGMA ignore_check_constraints = ON");
    raw.run(
      "INSERT INTO context_files(cwd, path, lang, purpose, lines, size, mtime_ms, digest, " +
      "symbols_json, status, touch_count, touched_at, mapped_at, updated_at) " +
      "VALUES (?, 'src/bad.ts', 'ts', NULL, 2, 5, 1, 'abc1234', '{', 'mapped', 0, NULL, ?, ?)",
      [root, now, now],
    );
    raw.close();

    const response = await fetch(mapUrl(task.id, "path=src/bad.ts"), {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("src/bad.ts");
    expect(body.files[0].symbols).toEqual([]);
  });
});
