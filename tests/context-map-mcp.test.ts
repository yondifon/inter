import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import { buildContextMap, mapLookup, projectSkeleton } from "../src/context-map";

const roots: string[] = [];
afterEach(() => {
  closeStateStore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.INTER_DB;
});

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "inter-map-mcp-"));
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

const files = {
  "src/store/a.ts": "export function alpha(x: number) { return x }\n",
  "src/b.ts": "export function beta() {}\n",
  "swift/Sources/App.swift": "public struct App {}\n",
};

function withLookupOff(root: string): void {
  writeFileSync(join(root, ".inter.toml"), "[map]\nlookup = false\n");
}

describe("mapLookup", () => {
  test("answers an exact path and a directory prefix", async () => {
    const root = workspace(files);
    buildContextMap(root);
    const exact = await mapLookup(root, { paths: ["src/b.ts"] }, ["**"]);
    expect(exact).toBeDefined();
    expect(exact!.files.map(({ path }) => path)).toEqual(["src/b.ts"]);
    expect(exact!.markdown).toContain("- L1 fn beta()");
    const dir = await mapLookup(root, { paths: ["src/store/"] }, ["**"]);
    expect(dir!.files.map(({ path }) => path)).toEqual(["src/store/a.ts"]);
    expect(dir!.markdown).not.toContain("fn beta");
  });

  test("answers a symbol and a prefix wildcard", async () => {
    const root = workspace(files);
    buildContextMap(root);
    const exact = await mapLookup(root, { symbols: ["alpha"] }, ["**"]);
    expect(exact!.files.map(({ path }) => path)).toEqual(["src/store/a.ts"]);
    const wildcard = await mapLookup(root, { symbols: ["App*"] }, ["**"]);
    expect(wildcard!.files.map(({ path }) => path)).toEqual(["swift/Sources/App.swift"]);
    const miss = await mapLookup(root, { symbols: ["nosuch"] }, ["**"]);
    expect(miss!.files).toEqual([]);
  });

  test("unrestricted by default: the read scope is the caller's choice", async () => {
    const root = workspace(files);
    buildContextMap(root);
    const whole = await mapLookup(root, { paths: ["swift/"] }, ["**"]);
    expect(whole!.files).toHaveLength(1);
    expect(whole!.outsideScope).toBe(0);
    const narrow = await mapLookup(root, { paths: ["swift/"] }, ["src/**"]);
    expect(narrow!.files).toHaveLength(0);
    expect(narrow!.outsideScope).toBe(1);
  });

  test("a project with no map row still answers with an empty header", async () => {
    const root = workspace(files);
    const result = await mapLookup(root, { paths: ["src/"] }, ["**"]);
    expect(result).toBeDefined();
    expect(result!.files).toEqual([]);
    expect(result!.markdown).toContain("# Context map —");
  });

  test("lookup = false turns the surface off", async () => {
    const root = workspace(files);
    buildContextMap(root);
    withLookupOff(root);
    expect(await mapLookup(root, { paths: ["src/"] }, ["**"])).toBeUndefined();
  });
});

describe("projectSkeleton", () => {
  test("no argument returns the whole project's shape", async () => {
    const root = workspace(files);
    buildContextMap(root);
    const skeleton = await projectSkeleton(root);
    expect(skeleton).toBeDefined();
    expect(skeleton!).toContain("# Context map —");
    expect(skeleton!).toContain("### src/store/a.ts · 1L");
    expect(skeleton!).toContain("### swift/Sources/App.swift · 1L");
    expect(skeleton!).not.toContain("fn alpha");
    expect(skeleton!).not.toContain("curl -s");
  });

  test("a project with no map row still renders the empty shape", async () => {
    const root = workspace(files);
    const skeleton = await projectSkeleton(root);
    expect(skeleton).toBeDefined();
    expect(skeleton!).toContain("0 files");
  });

  test("lookup = false turns the surface off", async () => {
    const root = workspace(files);
    buildContextMap(root);
    withLookupOff(root);
    expect(await projectSkeleton(root)).toBeUndefined();
  });
});
