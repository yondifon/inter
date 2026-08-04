import { describe, expect, test } from "bun:test";
import { accumulateRunCost, runCostFrom } from "../src/tasks";

// Verbatim from a real pi run, read out of the app's event inspector.
const messageEnd = {
  api: "openai-completions",
  content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "…" }],
  model: "deepseek-v4-flash",
  provider: "opencode-go",
  rawStopReason: "tool_calls",
  responseId: "073984d3-a055-4e04-90fe-73944037863f",
  role: "assistant",
  stopReason: "toolUse",
  timestamp: 1785605610108,
  usage: {
    cacheRead: 15104,
    cacheWrite: 0,
    cost: {
      cacheRead: 4.22912e-05,
      cacheWrite: 0,
      input: 0.00027132,
      output: 3.164e-05,
      total: 0.0003452512,
    },
    input: 1938,
    output: 113,
    reasoning: 30,
    totalTokens: 17155,
  },
  type: "message_end",
};

describe("pi run cost extraction", () => {
  test("reads a message_end's cost from usage.cost.total", () => {
    expect(accumulateRunCost({}, messageEnd)).toEqual({ costUsd: 0.0003452512 });
  });

  test("accumulates across message_end events instead of overwriting", () => {
    const second = { ...messageEnd, usage: { ...messageEnd.usage, cost: { total: 1.23 } } };
    const third = { ...messageEnd, usage: { ...messageEnd.usage, cost: { total: 0.5 } } };
    const run = [messageEnd, second, third].reduce(accumulateRunCost, {});
    // 0.0003452512 + 1.23 + 0.5; floating point, so compare within epsilon.
    expect(run.costUsd).toBeCloseTo(1.7303452512, 10);
  });

  test("leaves cost undefined when a run reports no usage", () => {
    expect(accumulateRunCost({}, { type: "message_end", role: "assistant", content: [] })).toEqual({});
    expect(accumulateRunCost({}, { type: "assistant", text: "working" })).toEqual({});
    // A message_end with no cost leaves a running total untouched.
    expect(accumulateRunCost({ costUsd: 0.5 }, { type: "message_end", role: "assistant", content: [] }))
      .toEqual({ costUsd: 0.5 });
  });

  test("accumulation never adds pi cost on top of a receipt", () => {
    const receipt = { type: "result", total_cost_usd: 1.64, num_turns: 21 };
    expect(accumulateRunCost({}, receipt)).toEqual({ costUsd: 1.64, turns: 21 });
    expect(accumulateRunCost({ costUsd: 3 }, receipt)).toEqual({ costUsd: 1.64, turns: 21 });
  });

  test("keeps other providers' cost extraction exactly as before", () => {
    expect(runCostFrom({ type: "result", total_cost_usd: 1.64, num_turns: 21 }))
      .toEqual({ costUsd: 1.64, turns: 21 });
    expect(runCostFrom({ event: "result", result: { num_turns: 4, total_cost_usd: 0.2 } }))
      .toEqual({ costUsd: 0.2, turns: 4 });
    expect(runCostFrom({ type: "assistant", text: "working" })).toEqual({});
    expect(runCostFrom({ type: "result", total_cost_usd: Number.NaN })).toEqual({});
  });

  test("pi reports nothing equivalent to turns, so it stays undefined", () => {
    expect(accumulateRunCost({}, messageEnd)).not.toHaveProperty("turns");
  });
});
