import { describe, expect, test } from "bun:test";
import { profileForCaller, profilesForCaller, publicProfile, publicProfiles } from "../src/profile-view";
import type { Profile } from "../src/types";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "claude-work",
    label: "Claude Work",
    provider: "claude",
    model: "opus",
    enabled: true,
    env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-work", ANTHROPIC_API_KEY: "s3cr3t" },
    capabilities: ["build", "review"],
    command: ["/opt/custom/claude-wrapper", "--profile", "work"],
    ...overrides,
  };
}

describe("profileForCaller (MCP profiles tool)", () => {
  test("carries only what a caller can act on", () => {
    const view = profileForCaller(profile());
    expect(Object.keys(view).sort()).toEqual([
      "capabilities", "enabled", "id", "label", "model", "provider",
    ]);
  });

  test("never carries env, even masked", () => {
    const view = profileForCaller(profile());
    expect(view).not.toHaveProperty("env");
  });

  test("never carries the launch command override", () => {
    const view = profileForCaller(profile());
    expect(view).not.toHaveProperty("command");
  });

  test("plural form applies the same trim to every profile", () => {
    const views = profilesForCaller([profile({ id: "a" }), profile({ id: "b" })]);
    for (const view of views) {
      expect(view).not.toHaveProperty("env");
      expect(view).not.toHaveProperty("command");
    }
  });
});

describe("publicProfile (HTTP /api/state and /api/profiles, the app's own surface)", () => {
  test("keeps env, masked, for the Settings screen", () => {
    const view = publicProfile(profile());
    expect(view.env.CLAUDE_CONFIG_DIR).toBe("$HOME/.claude-work");
    expect(view.env.ANTHROPIC_API_KEY).toBe("••••••••");
  });

  test("keeps the launch command override the app displays as read-only", () => {
    const view = publicProfile(profile());
    expect(view.command).toEqual(["/opt/custom/claude-wrapper", "--profile", "work"]);
  });

  test("plural form masks every profile's env", () => {
    const [a] = publicProfiles([profile({ env: { SECRET_TOKEN: "x" } })]);
    expect(a!.env.SECRET_TOKEN).toBe("••••••••");
  });
});
