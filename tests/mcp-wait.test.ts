import { describe, expect, test } from "bun:test";
import { mcpWaitBlockMs } from "../src/mcp-wait";

describe("MCP wait budget", () => {
  test("returns immediately by default", () => {
    expect(mcpWaitBlockMs(0)).toBe(0);
  });

  test("lets requests under the cap block for real", () => {
    expect(mcpWaitBlockMs(5_000)).toBe(5_000);
    expect(mcpWaitBlockMs(30_000)).toBe(30_000);
  });

  test("clamps requests over the cap to the 30s ceiling", () => {
    expect(mcpWaitBlockMs(300_000)).toBe(30_000);
  });
});
