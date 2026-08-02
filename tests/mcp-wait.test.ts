import { describe, expect, test } from "bun:test";
import { mcpWaitBlockMs } from "../src/mcp-wait";

describe("MCP wait budget", () => {
  test("returns immediately by default", () => {
    expect(mcpWaitBlockMs(0)).toBe(0);
  });

  test("caps legacy long waits so they cannot own the caller turn", () => {
    expect(mcpWaitBlockMs(30_000)).toBe(250);
    expect(mcpWaitBlockMs(300_000)).toBe(250);
  });
});
