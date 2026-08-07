import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

let tmp: string;
let stubs: string;
let inflight0: string;
let inflight1: string;
let inflight2: string;
let ptyAvailable = false;

function stub(name: string, body: string): string {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeToolsDir(files: Record<string, string>): string {
  const dir = join(tmp, `tools-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

async function run(
  script: string,
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["/bin/sh", script, ...args],
    cwd: repo,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

async function runWithFakeTools(
  script: string,
  args: string[],
  toolDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, PATH: `${toolDir}:${process.env.PATH ?? ""}` };
  return run(script, args, { env });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "inter-install-tests-"));
  stubs = join(tmp, "stubs");
  mkdirSync(stubs, { recursive: true });
  inflight0 = stub("inflight-0", "exit 0");
  inflight1 = stub("inflight-1", "exit 1");
  inflight2 = stub("inflight-2", "exit 2");
  const probe = Bun.spawn({
    cmd: ["python3", "-c", "import pty; pty.openpty()"],
    stdout: "ignore",
    stderr: "ignore",
  });
  ptyAvailable = (await probe.exited) === 0;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("install-guard", () => {
  const guard = join(repo, "scripts", "install-guard.sh");

  test("passes silently in the normal case", async () => {
    const { code, stdout } = await run(guard, []);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("refuses to run as root", async () => {
    const tools = fakeToolsDir({ id: "echo 0" });
    const { code, stdout } = await runWithFakeTools(guard, [], tools);
    expect(code).toBe(1);
    expect(stdout).toContain("do not run make install with sudo");
  });

  test("stops on a root-owned app and prints the exact removal command", async () => {
    const app = join(tmp, "RootOwnedApp.app");
    mkdirSync(app, { recursive: true });
    const tools = fakeToolsDir({ stat: "echo 0" });
    const { code, stdout } = await runWithFakeTools(guard, [app], tools);
    expect(code).toBe(1);
    expect(stdout).toContain("owned by root");
    expect(stdout).toContain(`sudo rm -rf ${app}`);
  });

  test("passes a non-root-owned app", async () => {
    const app = join(tmp, "UserOwnedApp.app");
    mkdirSync(app, { recursive: true });
    const { code, stdout } = await run(guard, [app]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});

describe("install-preflight", () => {
  const preflight = join(repo, "scripts", "install-preflight.sh");

  test("nothing in flight: silent pass", async () => {
    const { code, stdout } = await run(preflight, [inflight0, ""]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("check unavailable: warns and continues", async () => {
    const { code, stdout } = await run(preflight, [inflight2, ""]);
    expect(code).toBe(0);
    expect(stdout).toContain("could not check for in-flight tasks");
  });

  test("tasks in flight, INTER_INSTALL_YES=1: continues without prompting", async () => {
    const { code, stdout } = await run(preflight, [inflight1, "1"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("tasks in flight, non-interactive stdin: continues, never blocks", async () => {
    const started = Date.now();
    const { code, stdout } = await run(preflight, [inflight1, ""]);
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(stdout).toContain("continuing anyway");
    expect(elapsed).toBeLessThan(2000);
  });

  test.skipIf(!ptyAvailable)("tasks in flight, tty with no one answering: bounded wait, then aborts", async () => {
    const inner = ["/bin/sh", preflight, inflight1, ""];
    const started = Date.now();
    const proc = Bun.spawn({
      cmd: ["python3", "-c", `
import pty, sys
sys.exit(pty.spawn(${JSON.stringify(inner)}))
`.trim()],
      cwd: repo,
      env: { ...process.env, INTER_PROMPT_TIMEOUT: "2" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const elapsed = Date.now() - started;
    expect(code).toBe(1);
    expect(stdout + stderr).toContain("install aborted");
    expect(elapsed).toBeLessThan(8000);
  });
});

test("fixtures exist", () => {
  expect(existsSync(join(repo, "Makefile"))).toBe(true);
});
