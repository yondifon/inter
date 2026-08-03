import { describe, expect, test } from "bun:test";
import { parseAntigravityModels, parseCodexModels, parseOpenCodeModels, parsePiModels } from "../src/models";
import type { Profile } from "../src/types";

const codex: Profile = {
  id: "codex-work",
  label: "Codex work",
  provider: "codex",
  model: "gpt-default",
  enabled: true,
  env: {},
  capabilities: [],
};

describe("model catalogs", () => {
  test("normalizes visible Codex models", () => {
    expect(parseCodexModels(JSON.stringify({ models: [
      { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
      { slug: "gpt-hidden", visibility: "hidden" },
    ] }), codex)).toEqual([{
      id: "gpt-a",
      label: "GPT A",
      provider: "codex",
      profileId: "codex-work",
      source: "discovered",
    }]);
  });

  test("keeps the codex reasoning effort ladder and its default", () => {
    const [model] = parseCodexModels(
      JSON.stringify({
        models: [{
          slug: "gpt-5.6-luna",
          display_name: "GPT-5.6-Luna",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast responses with lighter reasoning" },
            { effort: "medium", description: "Balances speed and reasoning depth" },
            { effort: "high", description: "Greater reasoning depth" },
            { effort: "xhigh", description: "Extra high reasoning depth" },
            { effort: "max", description: "Maximum reasoning depth" },
          ],
        }],
      }),
      codex,
    );

    expect(model!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model!.defaultEffort).toBe("medium");
  });

  test("omits the effort ladder when the provider publishes none", () => {
    const [model] = parseCodexModels(
      JSON.stringify({ models: [{ slug: "gpt-a", visibility: "list" }] }),
      codex,
    );

    expect(model!.efforts).toBeUndefined();
    expect(model!.defaultEffort).toBeUndefined();
  });

  test("normalizes OpenCode provider/model lines", () => {
    const profile = { ...codex, provider: "opencode" as const };
    expect(parseOpenCodeModels("openai/gpt-5\nbad line\nanthropic/sonnet\n", profile).map(({ id }) => id))
      .toEqual(["openai/gpt-5", "anthropic/sonnet"]);
  });

  test("keeps OpenCode pricing and capability metadata", () => {
    const profile = { ...codex, provider: "opencode" as const };
    const [model] = parseOpenCodeModels(`opencode/kimi-k3
{
  "cost": { "input": 0.4, "output": 2.0 },
  "limit": { "context": 262144 },
  "capabilities": { "reasoning": true, "toolcall": true }
}
`, profile);
    expect(model).toMatchObject({
      id: "opencode/kimi-k3",
      reasoning: true,
      toolCall: true,
      cost: { input: 0.4, output: 2 },
      contextWindow: 262144,
    });
  });

  test("normalizes Antigravity model lines", () => {
    const profile = { ...codex, provider: "antigravity" as const };
    expect(parseAntigravityModels(
      "gemini-3.6-flash-low\nclaude-sonnet-4-6\nAvailable agents:\n",
      profile,
    ).map(({ id }) => id)).toEqual(["gemini-3.6-flash-low", "claude-sonnet-4-6"]);
  });

  test("parses pi's padded model table and attaches the ladder to reasoning models", () => {
    const profile = { ...codex, provider: "pi" as const };
    const models = parsePiModels(
      [
        "provider  model            context  max-out  thinking  images",
        "anthropic  claude-sonnet-4-6  200K     64K      yes       yes",
        "opencode   nemotron-3-super-free  1M   32K      no        no",
      ].join("\n"),
      profile,
    );
    expect(models.map(({ id }) => id))
      .toEqual(["anthropic/claude-sonnet-4-6", "opencode/nemotron-3-super-free"]);
    expect(models[0]!.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(models[1]!.efforts).toBeUndefined();
    expect(models[1]!.reasoning).toBe(false);
  });

  test("drops pi's prose outputs so the configured model stands in", () => {
    const profile = { ...codex, provider: "pi" as const };
    expect(parsePiModels("No models matching \"sonnet\"\n", profile)).toEqual([]);
  });
});
