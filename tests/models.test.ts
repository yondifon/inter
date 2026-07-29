import { describe, expect, test } from "bun:test";
import { parseCodexModels, parseOpenCodeModels } from "../src/models";
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
});
