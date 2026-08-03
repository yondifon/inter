import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findWorkerExecutable, resetWorkerPath, resolveWorkerExecutable, workerPath } from "../src/worker-path";

const roots: string[] = [];
const snapshot = { PATH: Bun.env.PATH, SHELL: Bun.env.SHELL };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  Bun.env.PATH = snapshot.PATH;
  Bun.env.SHELL = snapshot.SHELL;
  resetWorkerPath();
});

// Stands in for the user's login shell: prints a PATH the broker's snapshot
// never had, the way an rc file that appends ~/.opencode/bin does.
function fixture(loginPath: string, banner = "") {
  const root = mkdtempSync(join(tmpdir(), "inter-worker-path-"));
  roots.push(root);
  const shell = join(root, "shell");
  writeFileSync(
    shell,
    `#!/bin/sh\n${banner ? `printf '%s\\n' '${banner}'\n` : ""}printf '__INTER_PATH__%s__INTER_END__' '${loginPath}'\n`,
  );
  chmodSync(shell, 0o700);
  return { root, shell };
}

function installExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const executable = join(dir, name);
  writeFileSync(executable, "");
  chmodSync(executable, 0o700);
  return executable;
}

describe("worker path", () => {
  test("resolves a CLI installed after the broker captured its PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-worker-path-"));
    roots.push(root);
    const bin = join(root, "late/bin");
    const executable = installExecutable(bin, "opencode");
    const { shell } = fixture(bin);
    Bun.env.PATH = join(root, "empty");
    Bun.env.SHELL = shell;
    resetWorkerPath();

    expect(findWorkerExecutable("opencode")).toBe(executable);
    expect(workerPath().split(":")).toContain(bin);
  });

  test("ignores banner output printed by the login shell", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-worker-path-"));
    roots.push(root);
    const bin = join(root, "late/bin");
    installExecutable(bin, "opencode");
    const { shell } = fixture(bin, "welcome to your shell");
    Bun.env.PATH = join(root, "empty");
    Bun.env.SHELL = shell;
    resetWorkerPath();

    expect(findWorkerExecutable("opencode")).not.toBeNull();
    expect(workerPath()).not.toContain("welcome");
  });

  test("keeps the broker snapshot ahead of login shell entries", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-worker-path-"));
    roots.push(root);
    const preferred = join(root, "snapshot/bin");
    const executable = installExecutable(preferred, "opencode");
    installExecutable(join(root, "login/bin"), "opencode");
    const { shell } = fixture(join(root, "login/bin"));
    Bun.env.PATH = preferred;
    Bun.env.SHELL = shell;
    resetWorkerPath();

    expect(resolveWorkerExecutable("opencode")).toBe(executable);
  });

  test("falls back to the bare name when nothing resolves", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-worker-path-"));
    roots.push(root);
    const { shell } = fixture(join(root, "login/bin"));
    Bun.env.PATH = join(root, "empty");
    Bun.env.SHELL = shell;
    resetWorkerPath();

    expect(resolveWorkerExecutable("nonexistent-cli")).toBe("nonexistent-cli");
  });
});
