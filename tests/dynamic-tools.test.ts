import { describe, expect, test } from "bun:test";
import { dynamicProfileTools } from "../src/dynamic-tools";
import type { Profile } from "../src/types";

function profile(id: string, enabled = true): Profile {
  return {
    id,
    label: id,
    provider: "codex",
    model: "gpt-5",
    enabled,
    env: {},
    capabilities: ["build"],
  };
}

describe("dynamic profile tools", () => {
  test("uses stable profile-specific names for enabled profiles", () => {
    expect(dynamicProfileTools([
      profile("codex-default"),
      profile("claude-work"),
      profile("disabled", false),
    ]).map(({ name }) => name)).toEqual([
      "codex_default_delegate",
      "claude_work_delegate",
    ]);
  });

  test("keeps normalized name collisions distinct", () => {
    const names = dynamicProfileTools([profile("codex-work"), profile("codex_work")])
      .map(({ name }) => name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe("codex_work_delegate");
    expect(names[1]).toMatch(/^codex_work_delegate_[a-f0-9]{6}$/);
  });
});
