import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeTaskScope, sandboxedCommand, sandboxProfile, scopeRefusedWrite } from "../src/task-scope";
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
  test("defaults to the whole working tree", () => {
    const cwd = workspace();
    expect(normalizeTaskScope(undefined, cwd)).toEqual({
      read: ["**"],
      write: ["**"],
    });
  });

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

  test("expands a bare directory rule to cover its subtree", () => {
    const cwd = workspace();
    // Seatbelt's literal dir grant covers no children; callers mean the tree.
    expect(normalizeTaskScope({ read: ["docs"], write: ["docs"] }, cwd)).toEqual({
      read: ["docs", "docs/**"],
      write: ["docs", "docs/**"],
    });
    // Files, explicit recursive rules, and paths that do not exist yet stay as stated.
    expect(normalizeTaskScope({
      read: ["README.md", "docs/**", "missing", "**", "."],
      write: [],
    }, cwd)).toEqual({
      read: ["README.md", "docs/**", "missing", "**"],
      write: [],
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

    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    const opencodePolicy = sandboxProfile(
      cwd,
      { read: [], write: [] },
      { ...profile, provider: "opencode" },
      ["/bin/sh"],
      scratch,
    );
    expect(opencodePolicy).toContain(`${process.env.HOME}/.opencode`);
    expect(opencodePolicy).not.toContain(`(allow file-write* (subpath "${process.env.HOME}"))`);
    // Project discovery and config loading happen before task scope is used.
    expect(opencodePolicy).toContain(
      `(allow file-read* (literal "${realpathSync(cwd)}/opencode.json"))`,
    );
    expect(opencodePolicy).toContain(
      `(allow file-read* (literal "${realpathSync(cwd)}/.opencode/opencode.jsonc"))`,
    );
    expect(opencodePolicy).toContain(
      `(allow file-read* (literal "${realpathSync(cwd)}/.git/config"))`,
    );
    expect(opencodePolicy).not.toContain(
      `(allow file-read* (subpath "${realpathSync(cwd)}/.git"))`,
    );
    expect(opencodePolicy).not.toContain(
      `(allow file-read* (literal "${process.env.HOME}/opencode.json"))`,
    );
    expect(claudePolicy).not.toContain("opencode.json");
    expect(opencodePolicy).toContain(`${process.env.HOME}/.cargo/bin`);
    expect(opencodePolicy).toContain(`${process.env.HOME}/.rustup`);
    expect(opencodePolicy).toContain('/opt/homebrew');
    expect(opencodePolicy).not.toContain(`${process.env.HOME}/.cargo/credentials.toml`);
    expect(claudePolicy).toContain('/usr/local/go');
    expect(claudePolicy).toContain(`${process.env.HOME}/go/pkg/mod`);
    expect(claudePolicy).toContain(`${process.env.HOME}/Library/Caches/go-build`);
    expect(claudePolicy).not.toContain(`(subpath "${process.env.HOME}/go")`);
  });

  test("lets every worker read Git's own config but not the rest of home", () => {
    const cwd = workspace();
    const scope = { read: ["src/**"], write: [] };
    for (const provider of ["claude", "codex", "opencode", "antigravity"] as const) {
      const policy = sandboxProfile(cwd, scope, { ...profile, provider }, ["/bin/sh"]);

      // Without this, git refuses to run at all: "unable to access
      // '~/.gitconfig': Operation not permitted" — before it reads a single
      // repository file.
      expect(policy).toContain(`(allow file-read* (literal "${process.env.HOME}/.gitconfig"))`);
      expect(policy).toContain(`(allow file-read* (subpath "${process.env.HOME}/.config/git"))`);

      // Granting the config must not grant the home directory around it.
      expect(policy).not.toContain(`(allow file-read* (subpath "${process.env.HOME}"))`);
      expect(policy).not.toContain(`(allow file-read* (subpath "${process.env.HOME}/.ssh"))`);
      expect(policy).not.toContain(`(allow file-write* (literal "${process.env.HOME}/.gitconfig"))`);
    }
  });

  test("allows OpenCode's legacy home config probe only outside Git projects", () => {
    const cwd = workspace();
    const policy = sandboxProfile(
      cwd,
      { read: [], write: [] },
      { ...profile, provider: "opencode" },
      ["/bin/sh"],
    );
    expect(policy).toContain(
      `(allow file-read* (literal "${process.env.HOME}/opencode.json"))`,
    );
    expect(policy).not.toContain(`(allow file-read* (subpath "${process.env.HOME}"))`);
  });

  test("grants configured runtime paths before the worker creates them", () => {
    const cwd = workspace();
    const configDir = join(tmpdir(), "inter-missing-claude-config");
    const worker = { ...profile, env: { CLAUDE_CONFIG_DIR: configDir } };
    const policy = sandboxProfile(cwd, { read: [], write: [] }, worker, ["/bin/sh"]);
    expect(policy).toContain(`(allow file-write* (literal "${configDir}"))`);
    expect(policy).toContain(`(allow file-read* (subpath "${configDir}"))`);
  });

  test("reads through symlinked profile config files", () => {
    const cwd = workspace();
    // Dotfile-managed homes symlink config entries elsewhere; seatbelt checks
    // the target, so the grant must follow the link.
    const configDir = mkdtempSync(join(tmpdir(), "inter-cfg-"));
    const dotfiles = mkdtempSync(join(tmpdir(), "inter-dotfiles-"));
    roots.push(configDir, dotfiles);
    writeFileSync(join(dotfiles, "AGENTS.md"), "instructions");
    symlinkSync(join(dotfiles, "AGENTS.md"), join(configDir, "AGENTS.md"));
    const worker = { ...profile, env: { CLAUDE_CONFIG_DIR: configDir } };
    const policy = sandboxProfile(cwd, { read: [], write: [] }, worker, ["/bin/sh"]);
    expect(policy).toContain(`(allow file-read* (literal "${realpathSync(join(dotfiles, "AGENTS.md"))}"))`);
  });

  test("lets codex read the global skills root and all workers write user temp", () => {
    const cwd = workspace();
    const codexPolicy = sandboxProfile(cwd, { read: [], write: [] }, { ...profile, provider: "codex" }, ["/bin/sh"]);
    expect(codexPolicy).toContain(`(allow file-read* (subpath "${process.env.HOME}/.agents"))`);
    // No write: the skills library is bootstrap data, not worker output.
    expect(codexPolicy).not.toContain(`(allow file-write* (subpath "${process.env.HOME}/.agents"))`);
    for (const provider of ["claude", "codex", "opencode", "antigravity"] as const) {
      const policy = sandboxProfile(cwd, { read: [], write: [] }, { ...profile, provider }, ["/bin/sh"]);
      // xcrun's cache bypasses TMPDIR; user temp itself stays closed so a
      // task cwd inside tmpdir keeps its write enforcement.
      expect(policy).toContain(`xcrun_db`);
      expect(policy).not.toContain(`(allow file-write* (subpath "${realpathSync(tmpdir())}"))`);
    }
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

  integrationTest("a bare directory scope rule reaches children inside the sandbox", async () => {
    const cwd = workspace();
    const scratch = mkdtempSync(join(tmpdir(), "inter-scratch-"));
    roots.push(scratch);
    mkdirSync(join(cwd, "docs", "deep"));
    writeFileSync(join(cwd, "docs", "deep", "leaf.txt"), "leaf");
    const scope = normalizeTaskScope({ read: ["docs"], write: ["docs"] }, cwd);
    const script = [
      "set -e",
      "test \"$(cat docs/deep/leaf.txt)\" = leaf",
      "printf ok > docs/deep/out.txt",
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
      const workerCwd = provider === "opencode" ? realpathSync(join(import.meta.dir, "..")) : cwd;
      const args = provider === "opencode"
        ? [command, "debug", "config", "--pure"]
        : [command, "--version"];
      const child = Bun.spawn(
        sandboxedCommand(args, workerCwd, { read: [], write: [] }, worker, scratch),
        {
          cwd: workerCwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PWD: workerCwd,
            TMPDIR: scratch,
            ...(provider === "opencode" ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
          },
        },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) throw new Error(`${provider} sandbox startup exited ${exitCode}: ${stderr}`);
    }
  });

  test("grants the interpreter a script CLI is launched through", () => {
    // pi is `#!/usr/bin/env node`, and a Node under the user's home sits in no
    // already-granted root: without this the run dies before its first line.
    const root = mkdtempSync(join(tmpdir(), "inter-shebang-"));
    roots.push(root);
    const runtime = join(root, "runtime", "bin");
    mkdirSync(runtime, { recursive: true });
    const interpreter = join(runtime, "fakenode");
    writeFileSync(interpreter, "#!/bin/sh\nexit 0\n");
    const cli = join(root, "fake-cli");
    writeFileSync(cli, `#!${interpreter}\n`);

    const policy = sandboxProfile(workspace(), { read: [], write: [] }, profile, [cli]);
    expect(policy).toContain(`(subpath "${realpathSync(runtime)}")`);
    // The install prefix too: Node stats it while building its module search path.
    expect(policy).toContain(`(subpath "${realpathSync(join(root, "runtime"))}")`);
  });

  test("reads the interpreter out of a /usr/bin/env shebang", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-shebang-env-"));
    roots.push(root);
    const cli = join(root, "env-cli");
    // `env` names the real interpreter in the second field, not the first.
    writeFileSync(cli, "#!/usr/bin/env sh\n");
    const policy = sandboxProfile(workspace(), { read: [], write: [] }, profile, [cli]);
    expect(policy).not.toContain('(subpath "/usr/bin/env")');
  });

  integrationTest("installed Rust tools can run inside an OpenCode sandbox", async () => {
    const cargo = Bun.which("cargo", { PATH: Bun.env.PATH });
    if (!cargo) return;
    const cwd = workspace();
    const scratch = mkdtempSync(join(tmpdir(), "inter-scratch-"));
    roots.push(scratch);
    const worker = { ...profile, provider: "opencode" as const };
    const child = Bun.spawn(
      sandboxedCommand([cargo, "--version"], cwd, { read: [], write: [] }, worker, scratch),
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`cargo sandbox startup exited ${exitCode}: ${stderr}`);
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

describe("scopeRefusedWrite", () => {
  const cwd = "/Users/dev/project";

  test("allows writes inside granted rules", () => {
    expect(scopeRefusedWrite("out/report.md", cwd, { read: ["**"], write: ["**"] })).toBeUndefined();
    expect(scopeRefusedWrite("docs/a.md", cwd, { read: ["**"], write: ["docs/**"] })).toBeUndefined();
    expect(scopeRefusedWrite("api.ts", cwd, { read: ["**"], write: ["api.ts"] })).toBeUndefined();
  });

  test("honors the bare-directory expansion for write rules", () => {
    // Needs a real directory for the expansion to stat, outside the always-
    // writable temp locations: the repo's own docs/ serves as the fixture.
    const root = realpathSync(join(import.meta.dir, ".."));
    const scope = normalizeTaskScope({ read: ["**"], write: ["docs"] }, root);
    expect(scope.write).toEqual(["docs", "docs/**"]);
    expect(scopeRefusedWrite("docs/a.md", root, scope)).toBeUndefined();
    expect(scopeRefusedWrite("src/api.ts", root, scope)).toBe(join(root, "src/api.ts"));
  });

  test("flags writes outside the granted write scope", () => {
    expect(scopeRefusedWrite("../escape.txt", cwd, { read: ["**"], write: ["**"] }))
      .toBe("/Users/dev/escape.txt");
    expect(scopeRefusedWrite("src/api.ts", cwd, { read: ["**"], write: ["docs/**"] }))
      .toBe("/Users/dev/project/src/api.ts");
    expect(scopeRefusedWrite("anything.txt", cwd, { read: ["**"], write: [] }))
      .toBe("/Users/dev/project/anything.txt");
  });

  test("never flags scratch and system temp locations", () => {
    expect(scopeRefusedWrite("/tmp/x.txt", cwd, { read: [], write: [] })).toBeUndefined();
    expect(scopeRefusedWrite("/private/var/folders/ab/T/x", cwd, { read: [], write: [] })).toBeUndefined();
    expect(scopeRefusedWrite("/scratch/dir/x", cwd, { read: [], write: [] }, "/scratch/dir")).toBeUndefined();
  });
});
