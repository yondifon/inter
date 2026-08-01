import { describe, expect, test } from "bun:test";
import { promptWithMemories } from "../src/memories";

describe("shared memories", () => {
  test("adds project facts to delegated prompts", () => {
    const prompt = promptWithMemories("Fix auth", [{
      cwd: "/tmp/project",
      key: "conventions/tests",
      value: "Use Bun tests",
      version: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    }]);
    expect(prompt).toContain("## Inter memories");
    expect(prompt).toContain("- conventions/tests: Use Bun tests");
    expect(prompt).toContain("report the conflict");
  });

  test("leaves prompts unchanged without memories", () => {
    expect(promptWithMemories("Fix auth", [])).toBe("Fix auth");
  });
});
