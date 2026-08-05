import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_NAMES, helpText } from "../src/cli-help";

/**
 * How `inter` decides what a caller asked for. Every case here runs the real
 * entrypoint as a child process, because the thing under test is what the
 * binary does with argv — an in-process call would skip the one branch that
 * used to boot a broker nobody asked for.
 */

const entry = join(import.meta.dir, "..", "src", "cli.ts");
let root: string;

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = probe.port;
  probe.stop();
  return port;
}

function spawnCli(args: string[], port: number) {
  return Bun.spawn(["bun", "run", entry, ...args], {
    env: {
      ...process.env,
      INTER_PORT: String(port),
      INTER_DB: join(root, "inter.db"),
      INTER_SOCK: join(root, "inter.sock"),
      INTER_ROOTS: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(args: string[]) {
  const port = freePort();
  const child = spawnCli(args, port);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, port };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "inter-dispatch-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bare `inter`", () => {
  test("prints help, exits 0, and binds nothing", async () => {
    const { stdout, stderr, code, port } = await runCli([]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: inter <command>");
    // The port stayed free, so the invocation that used to start a broker no
    // longer does.
    expect(await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined)).toBeUndefined();
  }, 30_000);

  test("`help`, `--help`, and `-h` print the same thing", async () => {
    const [bare, ...spellings] = await Promise.all(
      [[], ["help"], ["--help"], ["-h"]].map((args) => runCli(args)),
    );

    for (const spelling of spellings) {
      expect(spelling.code).toBe(0);
      expect(spelling.stdout).toBe(bare!.stdout);
    }
  }, 30_000);
});

describe("the help text", () => {
  test("names every command the error message offers", () => {
    for (const name of COMMAND_NAMES) {
      expect(helpText()).toContain(name);
    }
  });

  test("says what Inter is before it says how to run it", () => {
    const text = helpText();
    expect(text.indexOf("Inter hands a task")).toBeLessThan(text.indexOf("Usage:"));
    expect(text).toContain("First run:");
  });
});

describe("`inter serve`", () => {
  test("starts a broker that answers /health", async () => {
    const port = freePort();
    const child = spawnCli(["serve"], port);
    try {
      let health: Response | undefined;
      for (let attempt = 0; attempt < 60 && !health; attempt += 1) {
        await Bun.sleep(250);
        health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      }
      expect(health?.status).toBe(200);
      expect((await health!.json()).status).toBe("ok");
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);
});

describe("an unknown command", () => {
  test("fails with a message naming what is available", async () => {
    const { stdout, stderr, code } = await runCli(["bogus"]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown command 'bogus'");
    for (const name of COMMAND_NAMES) {
      expect(stderr).toContain(name);
    }
  }, 30_000);
});
