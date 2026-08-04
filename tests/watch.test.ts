import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeStateStore, stateStore } from "../src/store";
import { DEFAULT_WATCH_TIMEOUT_MS, parseWatchArgs, runWatch, watchCommand } from "../src/watch";
import type { Task, TaskState } from "../src/types";

let root: string;

function seedTask(state: TaskState, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    profileId: "watch-fake",
    model: "fake",
    prompt: "seed",
    cwd: root,
    state,
    createdAt: now,
    updatedAt: now,
    output: "",
    scope: { read: [root], write: [root] },
    allowQuestions: true,
    ...overrides,
  };
  stateStore().createTask(task);
  return task;
}

/** Everything `runWatch` said, so a test can assert the line count as well as the text. */
async function watch(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWatch(argv, (line) => out.push(line), (line) => err.push(line));
  return { code, out, err };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "inter-watch-"));
  process.env.INTER_DB = join(root, "inter.db");
  stateStore().saveProfiles([{
    id: "watch-fake",
    label: "Watch Fake",
    provider: "antigravity",
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
  }]);
});

afterAll(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  rmSync(root, { recursive: true, force: true });
});

describe("argument parsing", () => {
  test("defaults the deadline so watch can never hang forever", () => {
    expect(parseWatchArgs(["abc"])).toEqual({ taskIds: ["abc"], timeoutMs: DEFAULT_WATCH_TIMEOUT_MS });
  });

  test("reads a duration in either flag form and in every unit", () => {
    expect(parseWatchArgs(["abc", "--timeout", "90s"])).toMatchObject({ timeoutMs: 90_000 });
    expect(parseWatchArgs(["--timeout=5m", "abc"])).toMatchObject({ timeoutMs: 300_000 });
    expect(parseWatchArgs(["abc", "-t", "2h"])).toMatchObject({ timeoutMs: 7_200_000 });
    // A bare number is milliseconds, like every other timeout in the codebase.
    expect(parseWatchArgs(["abc", "--timeout", "1500"])).toMatchObject({ timeoutMs: 1_500 });
  });

  test("takes several ids so one watch can follow a whole fan-out", () => {
    expect(parseWatchArgs(["a", "b", "c"])).toMatchObject({ taskIds: ["a", "b", "c"] });
  });

  test("refuses input it cannot act on", () => {
    expect(parseWatchArgs([])).toEqual({ error: "at least one task id is required" });
    expect(parseWatchArgs(["abc", "--timeout"])).toEqual({ error: "--timeout needs a value" });
    expect(parseWatchArgs(["abc", "--timeout", "soon"])).toEqual({ error: "not a duration: soon" });
    expect(parseWatchArgs(["abc", "--nope"])).toEqual({ error: "unknown option: --nope" });
  });
});

describe("what watch reports", () => {
  test("a completed task exits 0 with one bare line", async () => {
    const task = seedTask("completed", { output: "the whole answer, ".repeat(500) });
    const { code, out, err } = await watch([task.id]);

    expect(code).toBe(0);
    expect(out).toEqual([`${task.id} completed`]);
    expect(err).toEqual([]);
  });

  test("a question comes back on the same line as the id", async () => {
    const task = seedTask("needs_input", { question: "Which database\nshould I target?" });
    const { code, out } = await watch([task.id]);

    expect(code).toBe(0);
    expect(out).toEqual([`${task.id} needs_input Which database should I target?`]);
  });

  test("a failure carries its error", async () => {
    const task = seedTask("failed", { error: "timeout after 600000ms" });
    const { code, out } = await watch([task.id]);

    expect(code).toBe(0);
    expect(out).toEqual([`${task.id} failed timeout after 600000ms`]);
  });

  test("a cancelled task settles too", async () => {
    const task = seedTask("cancelled", { error: "cancelled by the user" });
    const { code, out } = await watch([task.id]);

    expect(code).toBe(0);
    expect(out).toEqual([`${task.id} cancelled cancelled by the user`]);
  });

  test("nothing to report exits non-zero and prints nothing at all", async () => {
    const task = seedTask("running");
    const { code, out, err } = await watch([task.id, "--timeout", "150"]);

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("only the tasks that settled get a line", async () => {
    const done = seedTask("completed");
    const running = seedTask("running");
    // The sibling never settles, so the watch now runs to its deadline: the
    // short one is what keeps the test from waiting out the default half hour.
    const { code, out } = await watch([done.id, running.id, "--timeout", "200"]);

    expect(code).toBe(0);
    expect(out).toEqual([`${done.id} completed`]);
  });

  test("an unknown id is a usage failure, not a silent timeout", async () => {
    const { code, out, err } = await watch(["no-such-task", "--timeout", "150"]);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join(" ")).toContain("unknown task");
    // A typo and a look in the wrong database read the same until the message
    // says which store it searched.
    expect(err.join(" ")).toContain(join(root, "inter.db"));
  });

  test("an archived task settles like any other, and says it is archived", async () => {
    const task = seedTask("completed", { title: "Port the parser", archivedAt: new Date().toISOString() });
    stateStore().setTaskArchived(task.id, true);
    const { code, out } = await watch([task.id]);

    expect(code).toBe(0);
    expect(out).toEqual([`${task.id} completed (archived) — Port the parser`]);
  });

  test("a title rides along so a fan-out's lines tell each other apart", async () => {
    const first = seedTask("completed", { title: "Port the parser" });
    const second = seedTask("needs_input", { title: "Wire the store", question: "Which database?" });
    const { code, out } = await watch([first.id, second.id]);

    expect(code).toBe(0);
    expect(out).toEqual([
      `${first.id} completed — Port the parser`,
      `${second.id} needs_input Which database? — Wire the store`,
    ]);
  });

  test("bad arguments exit 2 and say how to use it", async () => {
    const { code, err } = await watch([]);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain(`usage: ${watchCommand("<taskId...>")}`);
  });
});

describe("what watch streams", () => {
  function seedEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    stateStore().appendTaskEvent(taskId, type, "running", payload);
  }

  function finish(task: Task): void {
    stateStore().saveTask({ ...task, state: "completed", updatedAt: new Date().toISOString() }, "completed");
  }

  /**
   * Events only stream if they land while the watch is already waiting, so
   * every case here emits from inside the run rather than before it.
   */
  async function streaming(argv: string[], emit: () => void) {
    const running = watch(argv);
    await Bun.sleep(60);
    emit();
    return await running;
  }

  test("prints the lifecycle and the errors, and none of the work between them", async () => {
    const task = seedTask("running");
    const { code, out, err } = await streaming([task.id, "--timeout", "5s"], () => {
      seedEvent(task.id, "worker_spawned", { provider: "antigravity", model: "fake" });
      seedEvent(task.id, "agent.event", { type: "tool", name: "read", input: { file_path: "/x/y.ts" } });
      seedEvent(task.id, "agent.event", { type: "command", command: "bun test" });
      seedEvent(task.id, "agent.event", { type: "message", text: "let me look at the store" });
      // The run that first needed this died with `failed` saying only that it
      // was reading from stdin; the reason was in the agent error row.
      seedEvent(task.id, "agent.error", { type: "error", error: { message: "Your workspace is out of credits" } });
      seedEvent(task.id, "scope_refusal", { error: "write outside scope:\n  /etc/hosts" });
      finish(task);
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      "Worker spawned: antigravity",
      "Agent error: Your workspace is out of credits",
      // Collapsed onto one line, because one event is one line.
      "Write refused by scope: write outside scope: /etc/hosts",
      "Task completed",
      `${task.id} completed`,
    ]);
    expect(err).toEqual([]);
  });

  test("skips the worker traffic without spinning on the rows it skipped", async () => {
    const task = seedTask("running");
    const started = Date.now();
    const { code, out } = await streaming([task.id, "--timeout", "400"], () => {
      seedEvent(task.id, "agent.event", { type: "tool", name: "grep", input: { pattern: "needle" } });
      seedEvent(task.id, "agent.event", { type: "file", name: "write", input: { file_path: "/x/y.ts" } });
      seedEvent(task.id, "agent.step_update", {
        event: "step_update",
        step_update: { step_type: "user_input", state: "DONE" },
      });
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    // A cursor left behind a skipped row would wake on that row again at once,
    // so a run that really slept out its deadline is the evidence it moved past.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  /**
   * A stalled heartbeat is real signal and the filter here would let it
   * through, but no heartbeat ever reaches this code: the store folds the whole
   * event type out of `listTaskEventsForTasks` as noise, quiet and stalled
   * alike. This test says so out loud rather than leaving the gap unmarked.
   */
  test("never sees a heartbeat, stalled or not, because the store drops them first", async () => {
    const task = seedTask("running");
    const { code, out } = await streaming([task.id, "--timeout", "250"], () => {
      seedEvent(task.id, "heartbeat", { elapsedMs: 10_000, silentMs: 1_000, stalled: false });
      seedEvent(task.id, "heartbeat", { elapsedMs: 130_000, silentMs: 120_000, stalled: true });
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
  });

  test("starts from where the log stands, not from the top of the trace", async () => {
    const task = seedTask("running");
    seedEvent(task.id, "worker_spawned", { provider: "antigravity" });
    const { code, out } = await streaming([task.id, "--timeout", "5s"], () => finish(task));

    // The rows already in the store belong to `inspect`. Replaying them would
    // bury the news under a trace that runs to thousands of lines.
    expect(code).toBe(0);
    expect(out).toEqual(["Task completed", `${task.id} completed`]);
  });

  test("a fan-out labels each event with the task it came from", async () => {
    const first = seedTask("running");
    const second = seedTask("running");
    const { code, out } = await streaming([first.id, second.id, "--timeout", "5s"], () => {
      seedEvent(first.id, "worker_spawned", { provider: "antigravity" });
      seedEvent(second.id, "worker_spawned", { provider: "kimi" });
      finish(first);
      finish(second);
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `${first.id.slice(0, 8)} Worker spawned: antigravity`,
      `${second.id.slice(0, 8)} Worker spawned: kimi`,
      `${first.id.slice(0, 8)} Task completed`,
      `${second.id.slice(0, 8)} Task completed`,
      `${first.id} completed`,
      `${second.id} completed`,
    ]);
  });

  test("drains a backlog bigger than one batch before reporting the settle", async () => {
    const task = seedTask("running");
    const { code, out } = await streaming([task.id, "--timeout", "5s"], () => {
      for (let index = 0; index < 150; index += 1) {
        seedEvent(task.id, "worker_spawned", { provider: `step ${index}` });
      }
      finish(task);
    });

    // One batch carries 100. The rest have to arrive without a second wait, and
    // the settle line has to come last or the trace reads out of order.
    expect(code).toBe(0);
    expect(out.length).toBe(152);
    expect(out[0]).toBe("Worker spawned: step 0");
    expect(out[149]).toBe("Worker spawned: step 149");
    expect(out[150]).toBe("Task completed");
    expect(out[151]).toBe(`${task.id} completed`);
  });

  test("the deadline still exits 1, having printed what it did see", async () => {
    const task = seedTask("running");
    const { code, out, err } = await streaming([task.id, "--timeout", "400"], () => {
      seedEvent(task.id, "worker_spawned", { provider: "antigravity" });
    });

    expect(code).toBe(1);
    expect(out).toEqual(["Worker spawned: antigravity"]);
    expect(err).toEqual([]);
  });

  test("an unknown id is refused before any waiting starts", async () => {
    const started = Date.now();
    const { code, out } = await watch(["no-such-task", "--timeout", "10s"]);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/**
 * The subcommand has to claim the process before the broker binds its port, and
 * the exit code is the whole notification, so both are worth one real spawn.
 */
describe("the actual command line", () => {
  async function run(...args: string[]) {
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), "watch", ...args], {
      env: { ...process.env, INTER_DB: join(root, "inter.db"), INTER_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  /**
   * The usage text and the `wait` tool description both print `watchCommand()`,
   * and `wait`'s is the only place an MCP caller learns this command exists. So
   * the invocation it names has to be one a caller can paste and run — the bug
   * was that it named `inter watch`, which is on nobody's PATH.
   */
  test("the invocation both descriptions print is one that actually runs", async () => {
    const task = seedTask("completed");
    const [command, ...argv] = watchCommand(task.id).split(" ");
    const child = Bun.spawn([command!, ...argv], {
      env: { ...process.env, INTER_DB: join(root, "inter.db"), INTER_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(code).toBe(0);
    expect(stdout.trimEnd()).toBe(`${task.id} completed`);
  }, 30_000);

  test("prints one line and exits 0 without ever serving HTTP", async () => {
    const task = seedTask("completed");
    const { code, stdout } = await run(task.id);

    expect(code).toBe(0);
    expect(stdout.trimEnd()).toBe(`${task.id} completed`);
  }, 30_000);

  test("exits 1 when the deadline passes with nothing to report", async () => {
    const task = seedTask("running");
    const { code, stdout, stderr } = await run(task.id, "--timeout", "300");

    expect(stderr).toBe("");
    expect(code).toBe(1);
    expect(stdout).toBe("");
  }, 30_000);

  // The store runs interrupted-task recovery when it is opened as the broker,
  // so a watcher that opened it that way would fail the task it came to watch.
  test("leaves a running task running instead of recovering it out from under the broker", async () => {
    const task = seedTask("running");
    await run(task.id, "--timeout", "300");

    expect(stateStore().getTask(task.id)?.state).toBe("running");
  }, 30_000);
});
