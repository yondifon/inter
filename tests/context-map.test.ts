import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import {
  buildContextMap,
  contextMapSection,
  foldContextMap,
  parseCorrections,
  pendingContextJobs,
  queryContextMap,
  queueContextFold,
  renderContextMap,
  sweepContextFiles,
} from "../src/context-map";
import { cancelTask } from "../src/tasks";
import type { Task } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  closeStateStore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.INTER_DB;
});

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "inter-map-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  stateStore().saveProfiles([{
    id: "p", label: "P", provider: "opencode", model: "m", enabled: true, env: {}, capabilities: [],
  }]);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const TS = "export function alpha(a: number) { return a }\nfunction beta() {}\n";

function task(cwd: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId: "p",
    model: "m",
    prompt: "work",
    cwd,
    state: "completed",
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    ...overrides,
  };
}

function writeEvent(path: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path } }] } };
}

function seedTaskWithWrites(cwd: string, paths: string[], output = ""): string {
  const store = stateStore();
  const seeded = task(cwd);
  store.createTask({ ...seeded, output });
  for (const path of paths) store.appendTaskEvent(seeded.id, "agent.message", "running", writeEvent(path));
  return seeded.id;
}

describe("buildContextMap", () => {
  test("walks the tree, extracts symbols, and writes the map row", () => {
    const root = workspace({
      "src/a.ts": TS,
      "src/deep/b.swift": "public struct View: Codable {}\n",
      "src/empty.ts": "export {}",
      "src/broken.ts": "function broken( {",
      "README.md": "readme",
      "src/package-lock.json": "{}",
    });
    buildContextMap(root);
    const store = stateStore();
    const rows = store.listContextFiles(root);
    expect(rows.map(({ path }) => path).sort()).toEqual(["src/a.ts", "src/broken.ts", "src/deep/b.swift"]);
    const broken = store.getContextFile(root, "src/broken.ts")!;
    expect(broken.status).toBe("unparsed");
    expect(broken.symbols).toEqual([]);
    const a = store.getContextFile(root, "src/a.ts")!;
    expect(a.symbols.map(({ name, exported }) => [name, exported])).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);
    const map = store.getContextMap(root)!;
    expect(map.state).toBe("ready");
    expect(map.fileCount).toBe(3);
    expect(map.symbolCount).toBe(3);
  });

  test("excludes gitignored paths, node_modules and lockfiles; honours negation", () => {
    const root = workspace({
      "src/a.ts": TS,
      "src/ignored.ts": TS,
      "src/kept.ts": TS,
      "node_modules/pkg/index.ts": TS,
      "dist/bundle.ts": TS,
      ".gitignore": "src/ignored.ts\nnode_modules/\n!src/kept.ts",
      "src/kept.ts.d": TS,
    });
    buildContextMap(root);
    const rows = stateStore().listContextFiles(root).map(({ path }) => path);
    expect(rows).toContain("src/a.ts");
    expect(rows).toContain("src/kept.ts");
    expect(rows).not.toContain("src/ignored.ts");
    expect(rows).not.toContain("node_modules/pkg/index.ts");
    expect(rows).not.toContain("dist/bundle.ts");
  });

  test("caps the walk and lands partial", () => {
    const root = workspace();
    for (let index = 0; index < 12; index++) writeFileSync(join(root, `f${index}.ts`), TS);
    const { partial } = buildContextMap(root, { maxFiles: 10, budgetMs: 2_000 });
    expect(partial).toBe(true);
    expect(stateStore().getContextMap(root)!.state).toBe("partial");
    expect(stateStore().listContextFiles(root)).toHaveLength(10);
  });

  test("preserves stored purposes across a rebuild", () => {
    const root = workspace({ "src/a.ts": TS });
    buildContextMap(root);
    const store = stateStore();
    const row = store.getContextFile(root, "src/a.ts")!;
    store.upsertContextFile({ ...row, symbols: row.symbols.map((s) => ({ ...s, purpose: "kept prose", confirmed: true })) });
    writeFileSync(join(root, "src/a.ts"), `${TS}\nexport function gamma() {}\n`);
    buildContextMap(root);
    const rebuilt = store.getContextFile(root, "src/a.ts")!;
    expect(rebuilt.symbols.find(({ name }) => name === "alpha")!.purpose).toBe("kept prose");
    expect(rebuilt.symbols.find(({ name }) => name === "gamma")!.purpose).toBeNull();
  });
});

describe("foldContextMap", () => {
  test("maps files a settled task wrote, idempotently", async () => {
    const root = workspace({ "src/a.ts": TS });
    const id = seedTaskWithWrites(root, [join(root, "src/a.ts")]);
    await foldContextMap(root, id);
    const first = stateStore().getContextFile(root, "src/a.ts")!;
    expect(first.symbols.map(({ name }) => name)).toEqual(["alpha", "beta"]);
    expect(first.touchCount).toBe(1);
    await foldContextMap(root, id);
    const second = stateStore().getContextFile(root, "src/a.ts")!;
    expect(second.symbols).toEqual(first.symbols);
    expect(second.digest).toBe(first.digest);
    expect(second.purpose).toBe(first.purpose);
  });

  test("two workers settling at once fold to the same final rows", async () => {
    const root = workspace({ "src/a.ts": TS });
    const store = stateStore();
    const first = seedTaskWithWrites(root, [join(root, "src/a.ts")]);
    const second = seedTaskWithWrites(root, [join(root, "src/a.ts")]);
    queueContextFold(root, first);
    queueContextFold(root, second);
    await Promise.all(pendingContextJobs());
    const row = store.getContextFile(root, "src/a.ts")!;
    expect(row.symbols.map(({ name }) => name)).toEqual(["alpha", "beta"]);
    const recount = store.getContextMap(root)!;
    expect(recount.fileCount).toBe(1);
    expect(recount.symbolCount).toBe(2);
  });

  test("deletes rows for files gone from disk, drops refused and out-of-cwd paths", async () => {
    const root = workspace({ "src/a.ts": TS, "src/gone.ts": TS });
    const store = stateStore();
    const id = seedTaskWithWrites(root, [
      join(root, "src/a.ts"),
      join(root, "src/gone.ts"),
      "/outside/project.ts",
    ]);
    store.appendTaskEvent(id, "scope_refusal", "running", { path: join(root, "src/gone.ts") });
    rmSync(join(root, "src/a.ts"));
    await foldContextMap(root, id);
    expect(store.getContextFile(root, "src/a.ts")).toBeUndefined();
    expect(store.getContextFile(root, "src/gone.ts")).toBeUndefined();
  });

  test("keeps purposes for surviving symbols and drops vanished ones", async () => {
    const root = workspace({ "src/a.ts": TS });
    const store = stateStore();
    buildContextMap(root);
    const row = store.getContextFile(root, "src/a.ts")!;
    store.upsertContextFile({ ...row, symbols: row.symbols.map((s) => ({ ...s, purpose: "stays", confirmed: true })) });
    writeFileSync(join(root, "src/a.ts"), `${TS}function delta() {}\n`);
    const id = seedTaskWithWrites(root, [join(root, "src/a.ts")]);
    await foldContextMap(root, id);
    const folded = store.getContextFile(root, "src/a.ts")!;
    const names = folded.symbols.map(({ name }) => name);
    expect(names).toEqual(["alpha", "beta", "delta"]);
    expect(folded.symbols.find(({ name }) => name === "alpha")!.purpose).toBe("stays");
    expect(folded.symbols.find(({ name }) => name === "alpha")!.confirmed).toBe(true);
    expect(folded.symbols.find(({ name }) => name === "delta")!.purpose).toBeNull();
  });

  test("applies worker corrections only to symbols the fresh extraction contains", async () => {
    const root = workspace({ "src/a.ts": TS });
    const store = stateStore();
    const id = seedTaskWithWrites(root, [], [
      "## Map corrections",
      "src/a.ts:alpha — The alpha entry point.",
      "src/a.ts:nosuch — This symbol does not exist.",
      "src/a.ts — A file purpose.",
      "src/missing.ts — Never seen.",
    ].join("\n"));
    await foldContextMap(root, id);
    const row = store.getContextFile(root, "src/a.ts")!;
    expect(row.purpose).toBe("A file purpose.");
    const alpha = row.symbols.find(({ name }) => name === "alpha")!;
    expect(alpha.purpose).toBe("The alpha entry point.");
    expect(alpha.confirmed).toBe(false);
    expect(row.symbols.find(({ name }) => name === "beta")!.purpose).toBeNull();
    expect(store.getContextFile(root, "src/missing.ts")).toBeUndefined();
  });

  test("a settle that bypasses update — cancellation — still folds the writes", async () => {
    const root = workspace({ "src/a.ts": TS });
    const store = stateStore();
    const id = seedTaskWithWrites(root, [join(root, "src/a.ts")], "work in flight");
    store.saveTask({ ...store.getTask(id)!, state: "running" } as Task, "state_changed", {}, []);
    store.appendTaskEvent(id, "scope_refusal", "running", { path: join(root, "other.ts") });
    await cancelTask(id, "stopped");
    await Promise.all(pendingContextJobs());
    const row = store.getContextFile(root, "src/a.ts")!;
    expect(row.symbols.map(({ name }) => name)).toEqual(["alpha", "beta"]);
    expect(store.getContextFile(root, "other.ts")).toBeUndefined();
  });

  test("parseCorrections drops escaping paths and caps the count", () => {
    const parsed = parseCorrections(
      "## Map corrections\n" +
      "a.ts:x — one\n" +
      "b.ts — two\n" +
      "/etc/passwd — three\n" +
      "../escape.ts — four\n" +
      "c.ts:y — five\n",
      "/tmp/proj",
    );
    expect(parsed.paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("renderContextMap and contextMapSection", () => {
  const files = {
    "src/w.ts": "export function w() {}\nfunction internalW() {}\n",
    "read/r.ts": "export function r() {}\n",
    "other/o.ts": "export function o() {}\n",
  };

  test("fills full for write scope, skeleton for read scope, index when the budget thins", () => {
    const root = workspace(files);
    buildContextMap(root);
    // read/ and other/ sit in the read scope only; src/ is writable.
    const seeded = task(root, { scope: { read: ["src/**", "read/**", "other/**"], write: ["src/**"] } });
    const { text, filesOmitted } = renderContextMap(seeded, { shipChars: 2_000, lookup: true });
    expect(filesOmitted).toBe(0);
    expect(text).toContain("## Project map");
    expect(text).toContain("### src/w.ts · 2L · ");
    expect(text).toContain("- L1 fn w()");
    expect(text).toContain("·int"); // internalW
    expect(text).toContain("·?"); // no purposes yet
    expect(text).toContain("### read/r.ts · 1L"); // skeleton: no digest, no symbols
    expect(text).not.toContain("fn r");
    expect(text).toContain(`curl -s 'http://127.0.0.1:7331/api/map?task=${seeded.id}`);
    // A budget that drops the tail of the read scope omits it and points at it.
    const otherBlock = text.slice(text.indexOf("## other/"));
    const thin = renderContextMap(seeded, { shipChars: text.length - otherBlock.length - 1, lookup: true });
    expect(thin.text).not.toContain("## other/");
    expect(thin.text).toMatch(/further files? not shown/);
  });

  test("points the omitted tail at the lookup endpoint", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root);
    const { text, filesOmitted } = renderContextMap(seeded, { shipChars: 700, lookup: true });
    expect(filesOmitted).toBeGreaterThan(0);
    expect(text).toContain(`further files not shown — query them: curl -s 'http://127.0.0.1:7331/api/map?task=${seeded.id}`);
  });

  test("a small map ships in full when it fits", () => {
    const root = workspace({ "src/w.ts": "export function w() {}\n" });
    buildContextMap(root);
    const seeded = task(root);
    const { text, filesOmitted } = renderContextMap(seeded, { shipChars: 6_000, lookup: true });
    expect(filesOmitted).toBe(0);
    expect(text).toContain("- L1 fn w()");
    expect(text).not.toContain("further files not shown");
  });

  test("omits files outside the task's read scope", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root, { scope: { read: ["src/**"], write: [] } });
    const { text } = renderContextMap(seeded, { shipChars: 6_000, lookup: true });
    expect(text).not.toContain("other/o.ts");
    expect(text).not.toContain("other");
  });

  test("ship=false returns the prompt untouched", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root);
    expect(contextMapSection("original prompt", seeded, { ship: false, shipChars: 6_000, lookup: true }))
      .toBe("original prompt");
  });

  test("ships header and instruction even with no map rows", () => {
    const root = workspace();
    const seeded = task(root);
    const section = contextMapSection("prompt", seeded, { ship: true, shipChars: 6_000, lookup: true });
    expect(section).toContain("## Project map");
    expect(section).toContain("# Context map —");
    expect(section).toContain("0 files");
  });

  test("lookup=false drops the curl instruction", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root);
    const { text } = renderContextMap(seeded, { shipChars: 6_000, lookup: false });
    expect(text).not.toContain("curl -s");
    expect(text).not.toContain("Not everything is listed below");
    expect(text).toContain("## Map corrections");
  });
});

describe("sweepContextFiles", () => {
  test("repairs a changed file inline and deletes a gone one", () => {
    const root = workspace({ "src/a.ts": TS });
    buildContextMap(root);
    const store = stateStore();
    const before = store.getContextFile(root, "src/a.ts")!;
    writeFileSync(join(root, "src/a.ts"), "export function gamma() {}\n");
    const { files } = sweepContextFiles(root);
    expect(files.find(({ path }) => path === "src/a.ts")!.symbols[0]!.name).toBe("gamma");
    expect(store.getContextFile(root, "src/a.ts")!.digest).not.toBe(before.digest);
    rmSync(join(root, "src/a.ts"));
    const swept = sweepContextFiles(root);
    expect(swept.files).toHaveLength(0);
    expect(store.getContextFile(root, "src/a.ts")).toBeUndefined();
  });

  test("bails to partial and rebuild when too much is stale at once", async () => {
    const root = workspace();
    for (let index = 0; index < 6; index++) writeFileSync(join(root, `f${index}.ts`), TS);
    buildContextMap(root);
    const store = stateStore();
    for (let index = 0; index < 2; index++) {
      writeFileSync(join(root, `f${index}.ts`), `export function changed${index}() {}\n`);
    }
    // 2 of 6 stale is 33% — over the 30% threshold.
    const swept = sweepContextFiles(root);
    expect(store.getContextMap(root)!.state).toBe("partial");
    expect(swept.staleKept.size).toBeGreaterThan(0);
    await Promise.all(pendingContextJobs());
    expect(store.getContextMap(root)!.state).toBe("ready");
    expect(store.getContextFile(root, "f0.ts")!.symbols[0]!.name).toBe("changed0");
  });
});

describe("queryContextMap", () => {  const files = {
    "src/store/a.ts": "export function alpha() {}\nexport function alphabet() {}\n",
    "src/b.ts": "export function beta() {}\n",
    "swift/Sources/App.swift": "public struct App {}\n",
  };

  test("answers exact paths, directory prefixes, and symbols", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root);
    const exact = queryContextMap(seeded, { paths: ["src/b.ts"] });
    expect(exact.files.map(({ path }) => path)).toEqual(["src/b.ts"]);
    expect(exact.markdown).toContain("- L1 fn beta()");
    const dir = queryContextMap(seeded, { paths: ["src/store/"] });
    expect(dir.files.map(({ path }) => path)).toEqual(["src/store/a.ts"]);
    expect(dir.markdown).not.toContain("fn beta");
    const symbol = queryContextMap(seeded, { symbols: ["alpha"] });
    expect(symbol.files.map(({ path }) => path)).toEqual(["src/store/a.ts"]);
    const prefix = queryContextMap(seeded, { symbols: ["alphab"] });
    expect(prefix.files).toHaveLength(0);
    const wildcard = queryContextMap(seeded, { symbols: ["alphab*"] });
    expect(wildcard.files.map(({ path }) => path)).toEqual(["src/store/a.ts"]);
    const batched = queryContextMap(seeded, { paths: ["src/store/", "src/b.ts"] });
    expect(batched.files).toHaveLength(2);
  });

  test("filters every result through the task's read scope and counts omissions", () => {
    const root = workspace(files);
    buildContextMap(root);
    const scoped = task(root, { scope: { read: ["src/**"], write: [] } });
    const result = queryContextMap(scoped, { paths: ["swift/"] });
    expect(result.files).toHaveLength(0);
    expect(result.outsideScope).toBe(1);
    expect(result.markdown).toContain("(1 path omitted: outside this task's read scope)");
  });

  test("heals stale rows and counts files gone from disk", () => {
    const root = workspace(files);
    buildContextMap(root);
    writeFileSync(join(root, "src/b.ts"), "export function changed() {}\n");
    rmSync(join(root, "src/store/a.ts"));
    const seeded = task(root);
    const result = queryContextMap(seeded, { paths: ["src/"] });
    expect(result.files.map(({ path }) => path)).toEqual(["src/b.ts"]);
    expect(result.files[0]!.symbols[0]!.name).toBe("changed");
    expect(result.gone).toBe(1);
    expect(result.markdown).toContain("(1 path omitted: no longer on disk)");
    expect(stateStore().getContextFile(root, "src/store/a.ts")).toBeUndefined();
  });

  test("tier=full overrides a directory prefix's skeleton default", () => {
    const root = workspace(files);
    buildContextMap(root);
    const seeded = task(root);
    const result = queryContextMap(seeded, { paths: ["src/"], tier: "full" });
    expect(result.markdown).toContain("- L1 fn beta()");
  });
});
