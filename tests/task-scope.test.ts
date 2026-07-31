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

  test("grants provider runtime paths without opening all of home or tmp", () => {
    const cwd = workspace();
    const scratch = join(tmpdir(), "inter-missing-scratch");
    const claudePolicy = sandboxProfile(cwd, { read: [], write: [] }, profile, ["/bin/sh"], scratch);
    if (typeof process.getuid === "function") {
      expect(claudePolicy).toContain(`/private/tmp/claude-${process.getuid()}`);
    }
    expect(claudePolicy).toContain('tmp/claude-[^/]*-cwd');
    expect(claudePolicy).not.toContain('(allow file-write* (subpath "/private/tmp"))');

    const opencodePolicy = sandboxProfile(
      cwd,
      { read: [], write: [] },
      { ...profile, provider: "opencode" },
      ["/bin/sh"],
      scratch,
    );
    expect(opencodePolicy).toContain(`${process.env.HOME}/.opencode`);
    expect(opencodePolicy).not.toContain(`(allow file-write* (subpath "${process.env.HOME}"))`);
  });

  test("grants configured runtime paths before the worker creates them", () => {
    const cwd = workspace();
    const configDir = join(tmpdir(), "inter-missing-claude-config");
    const worker = { ...profile, env: { CLAUDE_CONFIG_DIR: configDir } };
    const policy = sandboxProfile(cwd, { read: [], write: [] }, worker, ["/bin/sh"]);
    expect(policy).toContain(`(allow file-write* (literal "${configDir}"))`);
    expect(policy).toContain(`(allow file-read* (subpath "${configDir}"))`);
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
    const workers = [
      { provider: "claude" as const, command: "claude" },
      { provider: "codex" as const, command: "codex" },
      { provider: "opencode" as const, command: "opencode" },
      { provider: "antigravity" as const, command: "agy" },
    ];
    for (const { provider, command } of workers) {
      if (!Bun.which(command)) continue;
      const worker = { ...profile, provider };
      const child = Bun.spawn(
        sandboxedCommand([command, "--version"], cwd, { read: [], write: [] }, worker, scratch),
        { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch } },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) throw new Error(`${provider} sandbox startup exited ${exitCode}: ${stderr}`);
    }
  });

  integrationTest("provider bootstrap paths are writable inside the sandbox", async () => {
    const cwd = workspace();
    const scratch = mkdtempSync(join(tmpdir(), "inter-scratch-"));
    roots.push(scratch);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined) {
      const probe = `/tmp/claude-${uid}/inter-sandbox-probe`;
      const cwdProbe = "/tmp/claude-d9ca-cwd";
      const deniedProbe = "/tmp/claude-d9ca-other";
      const child = Bun.spawn(
        sandboxedCommand(
          ["/bin/sh", "-c", [
            `touch ${probe}`,
            `touch ${cwdProbe}`,
            `! touch ${deniedProbe}`,
            `rm ${probe} ${cwdProbe}`,
          ].join(" && ")],
          cwd,
          { read: [], write: [] },
          profile,
          scratch,
        ),
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) throw new Error(`claude temp probe exited ${exitCode}: ${stderr}`);
    }

    const opencodeProbe = join(process.env.HOME!, ".opencode", "inter-sandbox-probe");
    const child = Bun.spawn(
      sandboxedCommand(
        ["/bin/sh", "-c", `touch ${opencodeProbe} && test -r ${opencodeProbe} && rm ${opencodeProbe}`],
        cwd,
        { read: [], write: [] },
        { ...profile, provider: "opencode" },
        scratch,
      ),
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`opencode config probe exited ${exitCode}: ${stderr}`);
  });
});
