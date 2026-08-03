import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deniedScopePaths, promptReadPaths } from "../src/prompt-paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-prompt-paths-"));
  roots.push(root);
  mkdirSync(join(root, "src", "api"), { recursive: true });
  writeFileSync(join(root, "src", "api", "handler.go"), "package api");
  writeFileSync(join(root, "README.md"), "read");
  return root;
}

describe("promptReadPaths", () => {
  test("extracts existing cwd-relative paths from prose and markdown", () => {
    const cwd = workspace();
    const prompt = [
      "# Goal",
      "Fix `src/api/handler.go` and update README.md.",
      "See src/api for the routing setup.",
    ].join("\n");
    expect(promptReadPaths(prompt, cwd)).toEqual(["src/api/handler.go", "README.md", "src/api"]);
  });

  test("ignores missing, absolute, escaping, and non-path tokens", () => {
    const cwd = workspace();
    const prompt = "fix src/api/missing.go and /etc/hosts, avoid ../secret, visit https://example.com/x, use bun test";
    expect(promptReadPaths(prompt, cwd)).toEqual([]);
  });

  test("caps extraction", () => {
    const cwd = workspace();
    for (let index = 0; index < 60; index++) writeFileSync(join(cwd, `f${index}.txt`), "x");
    const prompt = Array.from({ length: 60 }, (_, index) => `f${index}.txt`).join(" ");
    expect(promptReadPaths(prompt, cwd, 50)).toHaveLength(50);
  });
});

describe("deniedScopePaths", () => {
  test("recovers read and write denials scoped to cwd", () => {
    const cwd = workspace();
    const { reads, writes } = deniedScopePaths([
      `{"error":"EPERM: operation not permitted, stat '${cwd}/pwa/src/app'"}`,
      `{"error":"Unknown: FileSystem.stat (${cwd}/pwa/src)"}`,
      `{"output":"ls: ${cwd}/api/internal: Operation not permitted"}`,
      `{"error":"${cwd}/forbidden.txt is outside the granted write scope; the sandbox refuses this write"}`,
      `{"error":"EPERM: operation not permitted, stat '/etc/passwd'"}`,
      `{"output":"find: fts_read: Operation not permitted"}`,
    ], cwd);
    expect(reads).toEqual(["pwa/src/app", "pwa/src", "api/internal"]);
    expect(writes).toEqual(["forbidden.txt"]);
  });

  test("returns empty sets when nothing was denied", () => {
    expect(deniedScopePaths(["{}"], workspace())).toEqual({ reads: [], writes: [] });
  });
});
