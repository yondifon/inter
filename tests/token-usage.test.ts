import { describe, expect, test } from "bun:test";
import { accumulateRunTokens, runTokensFrom } from "../src/tasks";

describe("run token extraction", () => {
  test("reads claude's closing receipt from usage.input_tokens/output_tokens", () => {
    const receipt = {
      type: "result",
      total_cost_usd: 1.64,
      num_turns: 21,
      usage: { input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 450 },
    };
    expect(runTokensFrom(receipt)).toEqual({ tokensIn: 1500, tokensOut: 450 });
  });

  test("reads a receipt nested under a result field", () => {
    const receipt = {
      event: "result",
      result: { num_turns: 4, total_cost_usd: 0.2, usage: { input_tokens: 80, output_tokens: 40 } },
    };
    expect(runTokensFrom(receipt)).toEqual({ tokensIn: 80, tokensOut: 40 });
  });

  test("leaves tokens undefined off a receipt with no usage", () => {
    expect(runTokensFrom({ type: "result", total_cost_usd: 1.64, num_turns: 21 })).toEqual({});
  });

  test("does not mistake codex's per-turn usage for a final receipt", () => {
    // turn.completed carries the exact same field names as claude's result
    // event; only `type: "result"` may replace the running total.
    const turn = { type: "turn.completed", usage: { input_tokens: 500, output_tokens: 200 } };
    expect(runTokensFrom(turn)).toEqual({});
  });

  test("accumulates codex's per-turn tokens instead of replacing them", () => {
    const first = { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 200 } };
    const second = { type: "turn.completed", usage: { input_tokens: 620, cached_input_tokens: 500, output_tokens: 90 } };
    const run = [first, second].reduce(accumulateRunTokens, {});
    // input_tokens includes the cached share on codex, unlike claude, so it is
    // subtracted before summing: (500-100) + (620-500) = 520.
    expect(run).toEqual({ tokensIn: 520, tokensOut: 290 });
  });

  // Verbatim shape from a real pi run (tests/pi-usage.test.ts's messageEnd).
  const messageEnd = {
    type: "message_end",
    role: "assistant",
    usage: { input: 1938, output: 113, cacheRead: 15104, cacheWrite: 0, reasoning: 30, totalTokens: 17155 },
  };

  test("accumulates pi's per-message tokens", () => {
    const second = { ...messageEnd, usage: { ...messageEnd.usage, input: 142, output: 1160 } };
    const run = [messageEnd, second].reduce(accumulateRunTokens, {});
    expect(run).toEqual({ tokensIn: 1938 + 142, tokensOut: 113 + 1160 });
  });

  test("does not double-count pi tokens on turn_end", () => {
    // turn_end carries the same message's usage message_end already counted.
    const turnEnd = { type: "turn_end", message: { role: "assistant", usage: messageEnd.usage } };
    const run = [messageEnd, turnEnd].reduce(accumulateRunTokens, {});
    expect(run).toEqual({ tokensIn: 1938, tokensOut: 113 });
  });

  test("accumulates opencode's per-step tokens", () => {
    const stepOne = { type: "step_finish", part: { tokens: { input: 300, output: 80 } } };
    const stepTwo = { type: "step_finish", part: { tokens: { input: 90, output: 25 } } };
    const run = [stepOne, stepTwo].reduce(accumulateRunTokens, {});
    expect(run).toEqual({ tokensIn: 390, tokensOut: 105 });
  });

  test("leaves the running total untouched on events with no usage", () => {
    expect(accumulateRunTokens({ tokensIn: 10, tokensOut: 5 }, { type: "assistant", text: "working" }))
      .toEqual({ tokensIn: 10, tokensOut: 5 });
    expect(accumulateRunTokens({}, { type: "message_end", role: "assistant", content: [] })).toEqual({});
  });
});
