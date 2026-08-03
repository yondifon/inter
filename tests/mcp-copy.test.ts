import { describe, expect, test } from "bun:test";
import { DELEGATE_DESCRIPTION, MCP_INSTRUCTIONS } from "../src/mcp-copy";

describe("MCP consent copy", () => {
  test("states what leaves the machine and who approves it", () => {
    expect(MCP_INSTRUCTIONS).toContain("saved memories");
    expect(MCP_INSTRUCTIONS).toContain("whatever the worker reads");
    expect(MCP_INSTRUCTIONS).toContain("approval for the destination");
    expect(DELEGATE_DESCRIPTION).toContain("approves a destination and data scope");
  });

  test("treats destination approval as durable rather than per-dispatch", () => {
    // The old copy demanded fresh consent before every delegate, which cost a
    // user round-trip per hand-off and taught callers to do the work themselves.
    expect(MCP_INSTRUCTIONS).toContain("do not re-ask per dispatch");
    expect(DELEGATE_DESCRIPTION).toContain("stands for later dispatches");
  });

  test("describes scope as a durable grant rather than a per-call default", () => {
    expect(MCP_INSTRUCTIONS).toContain("a grant on that cwd for that profile");
    expect(MCP_INSTRUCTIONS).toContain("reuses the newest grant");
    expect(MCP_INSTRUCTIONS).toContain("flagged");
    // A grant belongs to a destination, not only a folder.
    expect(MCP_INSTRUCTIONS).toContain("approved for a different profile");
    expect(MCP_INSTRUCTIONS).toContain("approval names a destination");
    expect(DELEGATE_DESCRIPTION).toContain("directory/** is recursive");
    expect(DELEGATE_DESCRIPTION).toContain("bare directory path grants its whole subtree");
    expect(DELEGATE_DESCRIPTION).toContain("join the read grant automatically");
    expect(DELEGATE_DESCRIPTION).toContain("suggestedScope");
    expect(DELEGATE_DESCRIPTION).toContain("newest grant for that cwd");
    expect(DELEGATE_DESCRIPTION).toContain("generated build paths");
  });

  test("no longer promises the old whole-tree default", () => {
    expect(MCP_INSTRUCTIONS).not.toContain("read and write default to **");
    expect(DELEGATE_DESCRIPTION).not.toContain("If omitted, read and write both default to **");
  });

  test("keeps task ids public and provider sessions private", () => {
    expect(MCP_INSTRUCTIONS).toContain("only the Inter task ID");
    expect(MCP_INSTRUCTIONS).toContain("provider session IDs stay private");
    expect(DELEGATE_DESCRIPTION).toContain("provider session IDs are private");
  });

  test("tells callers to follow with wait rather than forget a task", () => {
    expect(MCP_INSTRUCTIONS).toContain("Dispatch returns immediately");
    expect(MCP_INSTRUCTIONS).toContain('until: "attention"');
    expect(MCP_INSTRUCTIONS).toContain("return control");
    expect(DELEGATE_DESCRIPTION).toContain("Dispatch returns immediately");
  });

  test("positions delegation for second opinions, capacity, and refused work", () => {
    expect(MCP_INSTRUCTIONS).toContain("second opinion");
    expect(MCP_INSTRUCTIONS).toContain("policy will not take");
    expect(MCP_INSTRUCTIONS).toContain("not limited to coding");
    expect(DELEGATE_DESCRIPTION).toContain("usage limit");
  });

  test("leads with routine execution rather than the exception cases", () => {
    // Framing every use as a fallback — second opinion, out of capacity,
    // refused work — is why callers did the work themselves instead.
    expect(MCP_INSTRUCTIONS).toContain("Route execution here by default");
    expect(DELEGATE_DESCRIPTION).toContain("a normal way to get work done");
  });

  test("stays short enough to be read rather than skimmed", () => {
    // The old blob ran to ~25 sentences and taught nothing a caller retained;
    // per-parameter descriptions carry the detail now.
    expect(MCP_INSTRUCTIONS.split(". ").length).toBeLessThan(15);
  });

  test("requires structured prompts instead of flattened prose", () => {
    expect(DELEGATE_DESCRIPTION).toContain("structured markdown");
    expect(DELEGATE_DESCRIPTION).toContain("never one flattened paragraph");
  });

  test("requires a title alongside the tldr and distinguishes them", () => {
    expect(DELEGATE_DESCRIPTION).toContain("Always pass title");
    expect(DELEGATE_DESCRIPTION).toContain("max 60 chars");
    expect(DELEGATE_DESCRIPTION).toContain("readable at a glance in a sidebar");
    expect(DELEGATE_DESCRIPTION).toContain("title is what you read in the list");
  });
});
