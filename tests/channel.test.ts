import { describe, expect, test } from "bun:test";
import { ChannelWatcher, WORTHY_STATES, channelEvent } from "../src/channel";
import type { TaskView } from "../src/channel";

function task(id: string, state: string, extra: Partial<TaskView> = {}): TaskView {
  return { id, profileId: "claude-work", cwd: "/tmp/project", state, ...extra };
}

describe("channel transition detection", () => {
  test("announces a transition exactly once", () => {
    const watcher = new ChannelWatcher();
    expect(watcher.apply([task("t1", "running")])).toEqual([]);

    const first = watcher.apply([task("t1", "needs_input", { question: "Which config?" })]);
    expect(first).toHaveLength(1);
    expect(first[0]!.params.meta.state).toBe("needs_input");

    expect(watcher.apply([task("t1", "needs_input", { question: "Which config?" })])).toEqual([]);
  });

  test("never re-announces a state for a task", () => {
    const watcher = new ChannelWatcher();
    watcher.apply([]);
    expect(watcher.apply([task("t1", "completed")])).toHaveLength(1);
    // A resumed task completing again stays quiet: the state was announced.
    expect(watcher.apply([task("t1", "running")])).toEqual([]);
    expect(watcher.apply([task("t1", "completed")])).toEqual([]);
  });

  test("the first poll seeds tasks that settled before the session opened", () => {
    // /api/state returns every unarchived task, so announcing them all on the
    // first poll would greet the caller with their whole backlog.
    const watcher = new ChannelWatcher();
    expect(watcher.apply([task("t1", "completed"), task("t2", "failed", { error: "boom" })]))
      .toEqual([]);
    // Seeded, not forgotten: they stay quiet afterwards too.
    expect(watcher.apply([task("t1", "completed")])).toEqual([]);
  });

  test("the first poll still announces a task parked on a question", () => {
    // A worker waiting on an answer is waiting right now, whenever it started.
    const watcher = new ChannelWatcher();
    const events = watcher.apply([task("t1", "completed"), task("t2", "needs_input")]);
    expect(events.map((event) => event.params.meta.task_id)).toEqual(["t2"]);
  });

  test("emits one event per newly worthy task in a single snapshot", () => {
    const watcher = new ChannelWatcher();
    watcher.apply([]);
    const events = watcher.apply([task("a", "completed"), task("b", "failed", { error: "boom" })]);
    expect(events.map((event) => event.params.meta.task_id).sort()).toEqual(["a", "b"]);
  });

  test("churn states emit nothing", () => {
    const watcher = new ChannelWatcher();
    const churn = ["queued", "running", "answered", "cancelled"];
    expect(watcher.apply(churn.map((state) => task(state, state)))).toEqual([]);
  });

  test("churn before a worthy state does not double-announce", () => {
    const watcher = new ChannelWatcher();
    watcher.apply([task("t1", "running"), task("t1", "answered")]);
    expect(watcher.apply([task("t1", "completed")])).toHaveLength(1);
  });

  test("the announced set stays bounded", () => {
    const watcher = new ChannelWatcher(2);
    watcher.apply([]);
    watcher.apply([task("a", "completed"), task("b", "completed"), task("c", "completed")]);
    expect(watcher.size).toBeLessThanOrEqual(2);
    // The oldest task was evicted, so its completed state may be announced again.
    expect(watcher.apply([task("a", "completed")])).toHaveLength(1);
  });
});

describe("channel notification shape", () => {
  test("every event uses the channel method", () => {
    const watcher = new ChannelWatcher();
    const events = watcher.apply([task("a", "completed"), task("b", "needs_input", { question: "q" })]);
    for (const event of events) {
      expect(event.method).toBe("notifications/claude/channel");
    }
  });

  test("meta carries task_id, state, cwd, and profile", () => {
    const event = channelEvent(task("t1", "failed", { error: "boom" }));
    expect(event.params.meta).toEqual({
      task_id: "t1",
      state: "failed",
      cwd: "/tmp/project",
      profile: "claude-work",
    });
  });

  test("meta carries the title when present and omits it otherwise", () => {
    expect(channelEvent(task("t1", "completed", { title: "Add dark mode" })).params.meta)
      .toMatchObject({ title: "Add dark mode" });
    expect(channelEvent(task("t1", "completed"))).not.toHaveProperty("params.meta.title");
  });

  test("content leads with the title, and reads without it", () => {
    const titled = channelEvent(task("t1", "completed", { title: "Add dark mode" }));
    expect(titled.params.content.startsWith("Add dark mode (t1)")).toBe(true);
    const untitled = channelEvent(task("t1", "completed"));
    expect(untitled.params.content.startsWith("Inter task t1 completed.")).toBe(true);
  });

  test("meta keys are identifier-only and values are strings", () => {
    const identifier = /^[A-Za-z0-9_]+$/;
    for (const state of WORTHY_STATES) {
      const event = channelEvent(task(`t-${state}`, state, { question: "q", error: "e" }));
      for (const key of Object.keys(event.params.meta)) {
        expect(key).toMatch(identifier);
      }
      for (const value of Object.values(event.params.meta)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  test("needs_input content carries the question verbatim and the identifiers", () => {
    const question = "Which config: prod or staging?\n  pick one.";
    const event = channelEvent(task("t1", "needs_input", { question }));
    expect(event.params.content).toContain(question);
    expect(event.params.content).toContain("t1");
    expect(event.params.content).toContain("claude-work");
    expect(event.params.content).toContain("/tmp/project");
    expect(event.params.content).toContain("reply tool");
  });

  test("needs_input falls back when no question is recorded", () => {
    const event = channelEvent(task("t1", "needs_input"));
    expect(event.params.content).toContain("(no question recorded)");
  });

  test("completed content carries task id, cwd, and an outcome line", () => {
    const event = channelEvent(task("t1", "completed", { output: "\n  done, 42 rows\nmore\n" }));
    expect(event.params.content).toContain("t1");
    expect(event.params.content).toContain("/tmp/project");
    expect(event.params.content).toMatch(/outcome: done, 42 rows/);
  });

  test("failed and blocked content carry the reason", () => {
    const failed = channelEvent(task("t1", "failed", { error: "exit 1" }));
    expect(failed.params.content).toMatch(/reason: exit 1/);

    const blocked = channelEvent(task("t2", "blocked", {
      completion: { code: "permission_denied", reason: "needs docs/ access" },
    }));
    expect(blocked.params.content).toMatch(/reason: needs docs\/ access/);
  });

  test("long outcomes are truncated", () => {
    const event = channelEvent(task("t1", "completed", { output: `${"word ".repeat(200)}` }));
    const outcome = event.params.content.split("\n")[1]!;
    expect(outcome).toMatch(/…$/);
  });
});
