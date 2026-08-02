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
    expect(MCP_INSTRUCTIONS).toContain("any saved Inter memories");
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

  test("positions delegation for second opinions and usage capacity", () => {
    expect(MCP_INSTRUCTIONS).toContain("second opinion");
    expect(MCP_INSTRUCTIONS).toContain("not limited to coding");
    expect(DELEGATE_DESCRIPTION).toContain("another model");
    expect(DELEGATE_DESCRIPTION).toContain("usage limit");
  });

  test("explains durable shared project memory", () => {
    expect(MCP_INSTRUCTIONS).toContain("memory tool");
    expect(MCP_INSTRUCTIONS).toContain("never store secrets");
    expect(MCP_INSTRUCTIONS).toContain("automatically includes memories");
  });

  test("documents scope semantics and expansion limits", () => {
    expect(MCP_INSTRUCTIONS).toContain("directory/** is recursive");
    expect(MCP_INSTRUCTIONS).toContain("** grants the whole working tree");
    expect(MCP_INSTRUCTIONS).toContain("hidden files and .git contents");
    expect(MCP_INSTRUCTIONS).toContain("Scope controls project data");
    expect(MCP_INSTRUCTIONS).toContain("read rule does not permit writes");
    expect(MCP_INSTRUCTIONS).toContain("resume retain the original scope");
    expect(MCP_INSTRUCTIONS).toContain("only the Inter task ID");
    expect(MCP_INSTRUCTIONS).toContain("provider session IDs private");
    expect(MCP_INSTRUCTIONS).toContain("session drift fails loudly");
    expect(DELEGATE_DESCRIPTION).toContain("directory/** is recursive");
    expect(DELEGATE_DESCRIPTION).toContain("generated build paths");
  });

  test("names the destination in dynamic delegate consent", () => {
    const description = dynamicDelegateDescription(profile);

    expect(description).toContain("codex profile Work");
    expect(description).toContain("worker-read project data");
    expect(description).toContain("current approval already covers it");
  });
});
