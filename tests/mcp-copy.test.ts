import { describe, expect, test } from "bun:test";
import {
  DELEGATE_DESCRIPTION,
  MCP_INSTRUCTIONS,
  dynamicDelegateDescription,
} from "../src/mcp-copy";
import type { Profile } from "../src/types";

const profile: Profile = {
  id: "codex-work",
  label: "Work",
  provider: "codex",
  model: "gpt-5.6-terra",
  enabled: true,
  env: {},
  capabilities: ["review"],
};

describe("MCP consent copy", () => {
  test("tells callers to route and ask before delegation", () => {
    expect(MCP_INSTRUCTIONS).toContain("call route first");
    expect(MCP_INSTRUCTIONS).toContain("Allow Inter to share <scope>");
    expect(MCP_INSTRUCTIONS).toContain("returned cursor");
    expect(MCP_INSTRUCTIONS).toContain("never show the raw policy rejection");
    expect(DELEGATE_DESCRIPTION).toContain("explicitly approved");
  });

  test("requires structured prompts instead of flattened prose", () => {
    expect(MCP_INSTRUCTIONS).toContain("structured markdown");
    expect(MCP_INSTRUCTIONS).toContain("Guardrails");
    expect(DELEGATE_DESCRIPTION).toContain("structured markdown");
    expect(DELEGATE_DESCRIPTION).toContain("never one flattened paragraph");
  });

  test("names the destination in dynamic delegate consent", () => {
    const description = dynamicDelegateDescription(profile);

    expect(description).toContain("codex profile Work");
    expect(description).toContain("worker-read project data");
    expect(description).toContain("current approval already covers it");
  });
});
