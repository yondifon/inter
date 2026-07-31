import { describe, expect, test } from "bun:test";
import { normalizeProfile } from "../src/profile-input";

describe("profile input", () => {
  test("uses the provider default when model is null or blank", () => {
    expect(normalizeProfile({ label: "Agy", provider: "antigravity", model: null }).model)
      .toBe("gemini-3.6-flash-medium");
    expect(normalizeProfile({ label: "Codex", provider: "codex", model: "  " }).model)
      .toBe("gpt-5");
  });

  test("keeps an explicitly selected default model", () => {
    expect(normalizeProfile({
      label: "Agy",
      provider: "antigravity",
      model: "claude-sonnet-4-6",
    }).model).toBe("claude-sonnet-4-6");
  });
});
