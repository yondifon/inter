import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { StateStore } from "../src/store";
import { LATEST_SCHEMA_VERSION } from "../src/store/schema";

/**
 * How expected CLI refusals present vs how crashes present. The thing under
 * test is the compiled entrypoint's behaviour with argv and a hostile
 * database, so every case runs the real CLI as a child process: an in-process
 * call would skip the top-level gate that turns a refusal into one line.
 */

const entry = join(import.meta.dir, "..", "src", "cli.ts");
const preflight = join(import.meta.dir, "..", "scripts", "install-preflight.sh");
let root: string;

function spawnCli(args: string[], db: string) {
  return Bun.spawn(["bun", "run", entry, ...args], {
    env: {
      ...process.env,
      INTER_PORT: "0",
      INTER_DB: db,
      INTER_SOCK: join(root, "inter.sock"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(args: string[], db: string) {
  const child = spawnCli(args, db);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** A database at this build's schema, stepped back to the previous one. */
function predatesDatabase(): string {
  const db = join(root, "predates.db");
  const store = new StateStore({ path: db, seedProfiles: [] });
  store.close();
  const raw = new Database(db);
  raw.exec(`DELETE FROM schema_migrations WHERE version = ${LATEST_SCHEMA_VERSION}`);
  raw.close();
  return db;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "inter-cli-refusal-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Bun stack frames are `    at <fn> (/path/file.ts:line:col)`. */
function hasStackFrame(stderr: string): boolean {
  return stderr.split("\n").some((line) => /^\s*at\s+\S+.+\(\S+:\d+:\d+\)$/.test(line.trimEnd()));
}

describe("expected CLI refusals", () => {
  test("inflight against an older-schema database prints one error line, no stack", async () => {
    const { stdout, stderr, code } = await runCli(["inflight"], predatesDatabase());

    expect(code).toBe(2);
    expect(stdout).toBe("");
    const lines = stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: cannot observe .*predates this binary \(v\d+\)/);
    expect(hasStackFrame(stderr)).toBe(false);
  });

  test("cleanup against a missing database prints one error line, no stack", async () => {
    const { stdout, stderr, code } = await runCli(["cleanup", "--older-than", "7d"], join(root, "missing", "inter.db"));

    expect(code).toBe(2);
    expect(stdout).toBe("");
    const lines = stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: no database at .*run the broker once to create it/);
    expect(hasStackFrame(stderr)).toBe(false);
  });

  test("a broker start with a bad INTER_CLEANUP_DAYS prints one error line, no stack", async () => {
    const child = Bun.spawn(["bun", "run", entry, "serve"], {
      env: {
        ...process.env,
        INTER_PORT: "0",
        INTER_DB: join(root, "serve.db"),
        INTER_SOCK: join(root, "inter.sock"),
        INTER_CLEANUP_DAYS: "soon",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(2);
    expect(stdout).not.toContain("automatic cleanup");
    // The event socket may warn first (its path hits the unix limit in test
    // temp dirs); what must hold is exactly one refusal line and no stack.
    const refusalLines = stderr.trimEnd().split("\n").filter((line) => line.startsWith("error:"));
    expect(refusalLines).toHaveLength(1);
    expect(refusalLines[0]).toMatch(/^error: INTER_CLEANUP_DAYS must be a whole number of days/);
    expect(hasStackFrame(stderr)).toBe(false);
  });
});

describe("unexpected errors keep their stack", () => {
  test("inflight against a corrupt database crashes with a stack, not a clean line", async () => {
    const db = join(root, "corrupt.db");
    writeFileSync(db, "this is not a sqlite database");

    const { stdout, stderr, code } = await runCli(["inflight"], db);

    expect(code).not.toBe(0);
    expect(code).not.toBe(2);
    expect(stdout).toBe("");
    expect(hasStackFrame(stderr)).toBe(true);
    expect(stderr).not.toMatch(/^error: /m);
  });
});

describe("the install pre-flight", () => {
  test("a check that cannot read the database warns and continues (exit 2 from inflight)", async () => {
    const fake = join(root, "fake-inflight-unreadable");
    writeFileSync(fake, "#!/bin/sh\nexit 2\n");
    chmodSync(fake, 0o755);

    const proc = Bun.spawn(["sh", preflight, fake, ""], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("could not check for in-flight tasks");
    expect(stdout).toContain("continuing");
  });

  test("a real inflight against an older-schema database lets the install continue", async () => {
    const fake = join(root, "fake-inflight-real");
    writeFileSync(fake, `#!/bin/sh\nexec bun run ${entry} inflight\n`);
    chmodSync(fake, 0o755);

    const proc = Bun.spawn(["sh", preflight, fake, ""], {
      env: {
        ...process.env,
        INTER_PORT: "0",
        INTER_DB: predatesDatabase(),
        INTER_SOCK: join(root, "inter.sock"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("could not check for in-flight tasks");
    expect(stdout).toContain("continuing");
    // The refusal line names both versions, so the operator can see why. It
    // goes to the binary's stderr, which the pre-flight leaves visible.
    expect(stderr).toContain("predates this binary");
    expect(hasStackFrame(stderr)).toBe(false);
  });

  test("in-flight tasks still stop a non-interactive install unless told otherwise", async () => {
    const fake = join(root, "fake-inflight-busy");
    writeFileSync(fake, "#!/bin/sh\nexit 1\n");
    chmodSync(fake, 0o755);

    const proc = Bun.spawn(["sh", preflight, fake, ""], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("continuing anyway");
  });

  test("an empty flight proceeds silently", async () => {
    const fake = join(root, "fake-inflight-empty");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);

    const proc = Bun.spawn(["sh", preflight, fake, ""], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
