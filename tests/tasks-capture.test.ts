import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as realTaskScope from "../src/task-scope";

// Same discipline as tasks-stream.test.ts: sandbox-exec cannot nest inside
// this sandboxed runner, so only the wrapper is replaced; the worker itself
// still runs as a real subprocess.
mock.module("../src/task-scope", () => ({
  ...realTaskScope,
  sandboxedCommand: (command: string[]) => command,
}));

const { compactPayload, delegate, getTask } = await import("../src/tasks");
const { closeStateStore, stateStore } = await import("../src/store");
import type { Profile } from "../src/types";

// A custom command means delegate exercises the real stream loop and capture
// path without needing a provider CLI on the machine; the provider field is
// what the capture path keys coalescing off.
function streamProfile(provider: Profile["provider"]): Profile {
  return {
    id: provider,
    label: provider,
    provider,
    model: "fake",
    enabled: true,
    env: {},
    capabilities: [],
  };
}

// JSON never contains a single quote, so each line is safe inside one.
function streamScript(lines: (string | Record<string, unknown>)[]): string {
  return lines
    .map((line) => typeof line === "string" ? line : JSON.stringify(line))
    .map((line) => `printf '%s\n' '${line}'`)
    .join("; ");
}

describe("capture coalescing and liveness", () => {
  const savedRoots = process.env.INTER_ROOTS;
  const savedDb = process.env.INTER_DB;
  const scratch: string[] = [];

  afterEach(() => {
    closeStateStore();
    if (savedRoots === undefined) delete process.env.INTER_ROOTS;
    else process.env.INTER_ROOTS = savedRoots;
    if (savedDb === undefined) delete process.env.INTER_DB;
    else process.env.INTER_DB = savedDb;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Same reasoning as tasks-stream.test.ts: returning before the run settles
  // leaves runTask calling stateStore() after afterEach closed it.
  async function settled(id: string, attempts = 200): Promise<import("../src/types").Task> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const task = getTask(id);
      if (task && !["queued", "running"].includes(task.state)) return task;
      await Bun.sleep(25);
    }
    throw new Error(`task never settled: ${id}`);
  }

  function capture(id: string, type = "agent.message_update") {
    return stateStore().listTaskEvents(id).filter((event) => event.type === type);
  }

  function block(event: { payload: Record<string, unknown> }): Record<string, unknown> {
    return event.payload.assistantMessageEvent as Record<string, unknown>;
  }

  test("coalesces a pi stream of deltas into one row per block", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // Two thinking blocks and a text block, with the toolcall fragments and
    // the tool_execution pair pi emits around the call. The whole stream is 22
    // message_update lines; only the three block boundaries may become rows.
    const script = streamScript([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "weighing" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " the " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "options" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "weighing the options" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Done." } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Done." } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 2 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "then " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "edit" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 2, content: "then edit" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCallId: "t1" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", toolCallId: "t1", delta: '{"name' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCallId: "t1", content: '{"name":"edit"}' } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { file_path: "a.txt" } },
      "INTER_RESULT: completed",
    ]);
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // One row per block, assembled text in the row — never a fragment.
    expect(updates).toHaveLength(3);
    expect(updates[0]!.payload.assistantMessageEvent).toEqual({ type: "thinking_end", content: "weighing the options" });
    expect(updates[1]!.payload.assistantMessageEvent).toEqual({ type: "text_end", content: "Done." });
    expect(updates[2]!.payload.assistantMessageEvent).toEqual({ type: "thinking_end", content: "then edit" });
    // The toolcall fragments are gone; the execution pair still records the call.
    expect(capture(task.id, "agent.tool_execution_start")).toHaveLength(1);
    const stored = stateStore().listTaskEvents(task.id);
    expect(stored.some((event) => String(block(event)?.type ?? "").startsWith("toolcall"))).toBe(false);
    // 22 stream lines, 4 stored agent rows.
    expect(stored.filter((event) => event.type.startsWith("agent."))).toHaveLength(4);
  }, 15_000);

  test("flushes a pi block that never ends so long stretches still show progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // Two deltas a second apart with no end between them: the 1 s threshold
    // must surface the first crossing as its own row while the block is still
    // open — the flush carries the text the block holds at that moment, so
    // both rows read "ab" and the row count is what proves the mid-block
    // flush happened — and the closing boundary adds the final row.
    const script = [
      `printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"a"}}'`,
      `sleep 2`,
      `printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"b"}}'`,
      `printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"ab"}}'`,
      `printf 'INTER_RESULT: completed\n'`,
    ].join("; ");
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // One row from the time flush, one from the closing boundary. Without the
    // time flush a never-ending block would store nothing, so a block that
    // crossed the threshold must have stored before its boundary arrived.
    expect(updates).toHaveLength(2);
    expect(block(updates[0]!)).toEqual({ type: "thinking_end", content: "ab" });
    expect(block(updates[1]!)).toEqual({ type: "thinking_end", content: "ab" });
  }, 15_000);

  test("a pi run that would previously hit the event cap now stays far under it", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // 6,000 token deltas in one block: pre-coalescing that was 6,000 stored
    // rows and an events_truncated marker; now the block folds into one row.
    const script = [
      `l='{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"x"}}'`,
      `i=0`,
      `while [ $i -lt 6000 ]; do printf '%s\\n' "$l"; i=$((i+1)); done`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"block"}}'`,
      `printf 'INTER_RESULT: completed\\n'`,
    ].join("; ");
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // The closing row carries the full assembled block; the burst may also
    // have crossed the 1 s flush threshold, so the bound is "a handful".
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.length).toBeLessThan(10);
    expect(block(updates.at(-1)!)).toEqual({ type: "thinking_end", content: "x".repeat(6000) });
    const stored = stateStore().listTaskEvents(task.id);
    expect(stored.some((event) => event.type === "events_truncated")).toBe(false);
    expect(stored.filter((event) => event.type.startsWith("agent.")).length).toBeLessThan(100);
  }, 15_000);

  test("another provider's capture of the same lines is byte-identical", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // The exact pi wire shapes on an opencode profile: every line must store
    // verbatim — the fold keys off the provider, never off the shape.
    const lines: Record<string, unknown>[] = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "weighing" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " the options" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "weighing the options" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCallId: "t1" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", toolCallId: "t1", delta: '{"name' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCallId: "t1", content: '{"name":"edit"}' } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { file_path: "a.txt" } },
    ];
    const script = streamScript([...lines, "INTER_RESULT: completed"]);
    stateStore().saveProfiles([{ ...streamProfile("opencode"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("opencode", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const rows = stateStore().listTaskEvents(task.id).filter((event) => event.type.startsWith("agent."));
    // One stored row per stream line, each exactly what the broker always
    // stored — compactPayload applied, nothing folded, nothing dropped. The
    // toolcall fragments land as agent.message_update rows, not agent.*_delta.
    expect(rows).toHaveLength(lines.length);
    for (let index = 0; index < lines.length; index++) {
      expect(rows[index]!.payload).toEqual(compactPayload(lines[index]!));
    }
    expect(rows.some((row) => row.type === "agent.message_update"
      && (row.payload.assistantMessageEvent as Record<string, unknown>).type === "toolcall_delta")).toBe(true);
  }, 15_000);

  test("liveness advances on pipe activity even when nothing is stored", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // A run that emits bytes but never a storable event: before the fix the
    // silence clock froze on the storage path and the heartbeat reported
    // silentMs of the whole elapsed run; now pipe activity keeps it honest.
    const script = [
      `i=0`,
      `while [ $i -lt 120 ]; do printf 'blah\\n'; sleep 0.1; i=$((i+1)); done`,
      `printf 'INTER_RESULT: completed\\n'`,
    ].join("; ");
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id, 1200);
    expect(done.state).toBe("completed");
    const heartbeats = stateStore().listTaskEvents(task.id).filter((event) => event.type === "heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
    const first = heartbeats[0]!;
    // 10 s of continuous bytes: the first heartbeat must see the pipe active,
    // not 10 s of "silence" measured since nothing was ever stored.
    expect(first.payload.stalled).toBe(false);
    expect(Number(first.payload.silentMs)).toBeLessThan(5_000);
  }, 30_000);

  test("flush rows carry only new text, not cumulative; closing row carries the whole block", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // Emit a block with deltas spaced to trigger flushes, then close. The key
    // invariant: flush rows carry only new text since the last flush, and the
    // closing boundary carries the whole assembled block. Concatenating the
    // flush contents should reconstruct the closing row's content, not exceed it.
    const script = [
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"aaa"}}'`,
      `sleep 1.5`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"bbb"}}'`,
      `sleep 1.5`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"ccc"}}'`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"aaabbbccc"}}'`,
      `printf 'INTER_RESULT: completed\\n'`,
    ].join("; ");
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // At least 2 rows: one or more flushes and the closing boundary.
    expect(updates.length).toBeGreaterThanOrEqual(2);

    // The last row must be the closing boundary with the whole block.
    const lastRow = block(updates[updates.length - 1]!);
    expect(lastRow.type).toBe("thinking_end");
    expect((lastRow as Record<string, unknown>).content).toBe("aaabbbccc");
    const closingContent = (lastRow as Record<string, unknown>).content as string;

    // All prior rows are flush rows. Concatenate their contents.
    const flushContents = updates.slice(0, -1).map((e) => block(e).content as string);
    const flushConcatenated = flushContents.join("");

    // The concatenated flush rows should equal the closing row's content, or be
    // a prefix of it (if the last few deltas arrived but no flush fired before close).
    // They should NOT be longer or contain repetition of earlier content.
    expect(closingContent.startsWith(flushConcatenated)).toBe(true);
    // The last row holds the complete text; flushes should never exceed it.
    expect(flushConcatenated.length).toBeLessThanOrEqual(closingContent.length);
  }, 15_000);

  test("a block that closes without flushing stores only the closing boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // Emit a short block (200 bytes total) in one burst, no time for flush:
    // this tests the pre-flush behavior is unchanged.
    const script = [
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}'`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"'$(printf 'x%.0s' {1..100})'"}}'`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"'$(printf 'y%.0s' {1..100})'"}}'`,
      `printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"'$(printf 'xy%.0s' {1..100})'"}}'`,
      `printf 'INTER_RESULT: completed\\n'`,
    ].join("; ");
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // Only the closing row, no intermediate flushes.
    expect(updates).toHaveLength(1);
    expect(block(updates[0]!)).toEqual({ type: "thinking_end", content: "x".repeat(100) + "y".repeat(100) });
  }, 15_000);

  test("toolcall fragments are still dropped outright", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // Mix toolcall fragments with real content; only the real content should store.
    const script = streamScript([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCallId: "t1" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", toolCallId: "t1", delta: '{"name' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCallId: "t1", content: '{"name":"edit"}' } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "x" } },
      "INTER_RESULT: completed",
    ]);
    stateStore().saveProfiles([{ ...streamProfile("pi"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("pi", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const updates = capture(task.id);
    // Only the thinking_end boundary; no toolcall rows.
    expect(updates).toHaveLength(1);
    expect(block(updates[0]!)).toEqual({ type: "thinking_end", content: "x" });
    expect(capture(task.id).some((e) => String(block(e)?.type ?? "").startsWith("toolcall"))).toBe(false);
  }, 15_000);

  test("another provider's identical-looking lines are still stored verbatim", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-capture-"));
    scratch.push(root);
    process.env.INTER_DB = join(root, "inter.db");
    process.env.INTER_ROOTS = root;
    // On opencode, the same lines must all store; the fold is pi-only.
    const lines = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "y" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "z" } },
    ];
    const script = streamScript([...lines, "INTER_RESULT: completed"]);
    stateStore().saveProfiles([{ ...streamProfile("opencode"), command: ["/bin/sh", "-c", script] }]);

    const task = await delegate("opencode", "prompt", root);
    const done = await settled(task.id);
    expect(done.state).toBe("completed");
    const rows = stateStore().listTaskEvents(task.id).filter((event) => event.type.startsWith("agent."));
    // All three deltas store as-is; no folding or skipping.
    expect(rows).toHaveLength(3);
    for (let index = 0; index < lines.length; index++) {
      expect(rows[index]!.payload).toEqual(compactPayload(lines[index]!));
    }
  }, 15_000);
});
