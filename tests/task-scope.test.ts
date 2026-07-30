import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeTaskScope, sandboxedCommand, sandboxProfile } from "../src/task-scope";
import type { Profile } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "worker",
  label: "Worker",
  provider: "claude",
  model: "sonnet",
  enabled: true,
  env: {},
  capabilities: [],
};

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-scope-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "read");
  return root;
}

describe("task scope", () => {
  test("accepts literal paths and recursive directories", () => {
    const cwd = workspace();
    expect(normalizeTaskScope({
      read: ["README.md", "docs/**"],
      write: ["docs/**"],
    }, cwd)).toEqual({
      read: ["README.md", "docs/**"],
      write: ["docs/**"],
    });
  });

  test("rejects traversal, unsupported globs, and symlink escapes", () => {
    const cwd = workspace();
    const outside = mkdtempSync(join(tmpdir(), "inter-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(cwd, "escape"));
    expect(() => normalizeTaskScope({ read: ["../secret"], write: [] }, cwd)).toThrow("inside cwd");
    expect(() => normalizeTaskScope({ read: ["docs/*.md"], write: [] }, cwd)).toThrow("/** suffixes");
    expect(() => normalizeTaskScope({ read: ["escape/**"], write: [] }, cwd)).toThrow("resolves outside cwd");
  });

  test("sandbox profile only grants project data named by scope", () => {
    const cwd = workspace();
    const scope = normalizeTaskScope({
      read: ["README.md", "docs/**"],
      write: ["docs/**"],
    }, cwd);
    const policy = sandboxProfile(cwd, scope, profile, ["/bin/sh"]);
    const actual = realpathSync(cwd);
    expect(policy).toContain(`(allow file-read* (literal "${actual}/README.md"))`);
    expect(policy).toContain(`(allow file-write* (subpath "${actual}/docs"))`);
    expect(policy).not.toContain(`(allow file-read* (subpath "${actual}"))`);
    expect(policy).not.toContain(`(allow file-write* (subpath "${actual}"))`);
  });

  const integrationTest = process.env.INTER_SANDBOX_INTEGRATION === "1" ? test : test.skip;
  integrationTest("macOS sandbox blocks reads and writes outside declared paths", async () => {
    const cwd = workspace();
    const scratch = mkdtempSync(join(tmpdir(), "inter-scratch-"));
    roots.push(scratch);
    writeFileSync(join(cwd, "secret.txt"), "secret");
    const scope = normalizeTaskScope({ read: ["README.md"], write: ["docs/**"] }, cwd);
    const script = [
      "set -e",
      "test \"$(cat README.md)\" = read",
      "test ! -r secret.txt",
      "printf allowed > docs/result.txt",
      "! printf denied > forbidden.txt",
    ].join("; ");
    const child = Bun.spawn(
      sandboxedCommand(["/bin/sh", "-c", script], cwd, scope, profile, scratch),
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`sandbox probe exited ${exitCode}: ${stderr}`);
  });

  integrationTest("installed worker CLIs can start inside the sandbox", async () => {
    const cwd = workspace();
    const scratch = mkdtempSync(join(tmpdir(), "inter-scratch-"));
    roots.push(scratch);
    for (const provider of ["claude", "codex", "opencode"] as const) {
      if (!Bun.which(provider)) continue;
      const worker = { ...profile, provider };
      const child = Bun.spawn(
        sandboxedCommand([provider, "--version"], cwd, { read: [], write: [] }, worker, scratch),
        { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch } },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) throw new Error(`${provider} sandbox startup exited ${exitCode}: ${stderr}`);
    }
  });
});
