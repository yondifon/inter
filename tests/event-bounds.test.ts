import { describe, expect, test } from "bun:test";
import { boundEventPayload, MAX_EVENT_PAYLOAD_BYTES } from "../src/event-bounds";
import { taskEventView } from "../src/events";

describe("boundEventPayload", () => {
  test("leaves a small payload untouched, byte for byte", () => {
    const payload = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } };
    const bounded = boundEventPayload(payload);
    expect(bounded).toBe(payload);
    expect(JSON.stringify(bounded)).toBe(JSON.stringify(payload));
  });

  test("truncates an oversized free-text leaf and marks it", () => {
    const big = "a".repeat(100_000);
    const payload = { type: "hello", small: "kept as-is", tool_response: { content: big } };
    const bounded = boundEventPayload(payload);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    expect(bounded.small).toBe("kept as-is");
    const content = (bounded.tool_response as { content: string }).content;
    expect(content.length).toBeLessThan(big.length);
    expect(content).toContain("…[truncated: kept");
    expect(content).toContain("of 100000 bytes]");
  });

  test("shrinks the largest leaf first when several fields are oversized", () => {
    const huge = "x".repeat(80_000);
    const medium = "y".repeat(1_000);
    const payload = { huge, medium, tag: "small" };
    const bounded = boundEventPayload(payload);
    expect(bounded.medium).toBe(medium);
    expect((bounded.huge as string).length).toBeLessThan(huge.length);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
  });

  test("an oversized hook payload renders the same taskEventView row as its untruncated form", () => {
    const bigFileEcho = "line of file content\n".repeat(5_000);
    const makePayload = (toolResponse: unknown) => ({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_use_id: "call_1",
      tool_input: {
        file_path: "/Users/malico/desgn/inter/.plans/activity-event-coverage.md",
        content: Array.from({ length: 241 }, (_, i) => `line ${i}`).join("\n"),
      },
      tool_response: toolResponse,
    });

    const untruncated = taskEventView({
      id: 1, taskId: "task", type: "agent.hook", state: "running",
      payload: makePayload({ filePath: "/repo/x.md", content: bigFileEcho }),
      createdAt: "now",
    }, "claude");

    const boundedPayload = boundEventPayload(makePayload({ filePath: "/repo/x.md", content: bigFileEcho }));
    expect(Buffer.byteLength(JSON.stringify(boundedPayload))).toBeLessThan(bigFileEcho.length);
    const truncated = taskEventView({
      id: 1, taskId: "task", type: "agent.hook", state: "running",
      payload: boundedPayload,
      createdAt: "now",
    }, "claude");

    expect(truncated.kind).toBe(untruncated.kind);
    expect(truncated.phase).toBe(untruncated.phase);
    expect(truncated.title).toBe(untruncated.title);
    expect(truncated.detail).toBe(untruncated.detail);
    expect(truncated.presentation).toEqual(untruncated.presentation);
    expect(truncated.title).toBe("Write file");
    expect(truncated.detail).toBe("…/inter/.plans/activity-event-coverage.md · 241 lines");
  });
});
