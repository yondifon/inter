import { describe, expect, test } from "bun:test";
import { chooseModel, classifyTask } from "../src/model-router";
import type { ModelInfo, Profile } from "../src/types";

const profiles: Profile[] = [
  { id: "claude", label: "Claude", provider: "claude", model: "sonnet", enabled: true, env: {}, capabilities: [] },
  { id: "opencode", label: "OpenCode", provider: "opencode", model: "opencode/big-pickle", enabled: true, env: {}, capabilities: [] },
];

const models: ModelInfo[] = [
  { id: "haiku", label: "Haiku", provider: "claude", profileId: "claude", source: "alias", cost: { input: 0.2, output: 1 } },
  { id: "sonnet", label: "Sonnet", provider: "claude", profileId: "claude", source: "configured", cost: { input: 3, output: 15 } },
  { id: "opus", label: "Opus", provider: "claude", profileId: "claude", source: "alias", cost: { input: 15, output: 75 } },
  { id: "opencode/kimi-k3", label: "Kimi K3", provider: "opencode", profileId: "opencode", source: "discovered", cost: { input: 0, output: 0 } },
  { id: "opencode/big-pickle", label: "Big Pickle", provider: "opencode", profileId: "opencode", source: "configured", cost: { input: 0, output: 0 } },
];

describe("model routing", () => {
  test("uses a cheap model for bounded mechanical work", () => {
    const route = chooseModel("Rename this variable in two files.", models, profiles);
    expect(route.taskClass).toBe("mechanical");
    expect(route.model).toBe("haiku");
  });

  test("uses stronger context comprehension for codebase reading", () => {
    const route = chooseModel("Read these files and understand how auth works.", models, profiles);
    expect(route.taskClass).toBe("context");
    expect(route.candidates[0]!.traits.quality).toBeGreaterThanOrEqual(4);
  });

  test("will not let low price beat required architecture quality", () => {
    const route = chooseModel("Architect a secure migration and analyze race conditions.", models, profiles, {
      preference: "cost",
    });
    expect(route.requiredQuality).toBe(5);
    expect(route.candidates[0]!.traits.quality).toBe(5);
  });

  test("resolves friendly model hints without a profile lookup", () => {
    const route = chooseModel("Implement the fix.", models, profiles, { modelHint: "kimi3" });
    expect(route.model).toBe("opencode/kimi-k3");
    expect(route.profileId).toBe("opencode");
  });

  test("classifies commit-message work as mechanical", () => {
    expect(classifyTask("Write a commit message for this diff.").requiredQuality).toBe(2);
  });
});
