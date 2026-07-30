import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseModel, classifyTask, routeModel } from "../src/model-router";
import type { ProfileStatus } from "../src/profile-status";
import type { RoutingPolicy } from "../src/routing-policy";
import { closeStateStore, stateStore } from "../src/store";
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

const buildPolicy: RoutingPolicy = {
  version: 1,
  path: "/project/.inter.toml",
  routes: {
    build: {
      preference: "quality",
      minQuality: 5,
      allow: [
        { provider: "claude", model: "opus" },
        { provider: "opencode", model: "opencode-go/*" },
      ],
    },
  },
};

describe("model routing", () => {
  test("loads project policy only when cwd is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-router-"));
    const previousCwd = process.cwd();
    const previousDb = process.env.INTER_DB;
    writeFileSync(join(root, ".inter.toml"), `
version = 1
[routes.build]
allow = [{ provider = "claude", model = "opus" }]
`);

    try {
      closeStateStore();
      process.env.INTER_DB = join(root, "inter.db");
      stateStore().saveProfiles([{
        id: "antigravity",
        label: "Antigravity",
        provider: "antigravity",
        model: "gemini",
        enabled: true,
        env: {},
        capabilities: [],
      }]);
      process.chdir(root);

      expect((await routeModel("Implement the fix.")).model).toBe("gemini");
      await expect(routeModel("Implement the fix.", { cwd: root }))
        .rejects.toThrow("no routable models are available");
    } finally {
      closeStateStore();
      process.chdir(previousCwd);
      if (previousDb === undefined) delete process.env.INTER_DB;
      else process.env.INTER_DB = previousDb;
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  test("excludes a profile with normalized unavailable status and warns why", () => {
    const route = chooseModel("Implement the fix.", models, profiles, {}, [{
      profile: "opencode",
      provider: "opencode",
      model: "opencode/kimi-k3",
      state: "unavailable",
      source: "task",
      reason: "Observed billing failure",
      checkedAt: "2026-07-30T12:00:00.000Z",
    }, {
      profile: "opencode",
      provider: "opencode",
      model: "opencode/big-pickle",
      state: "unavailable",
      source: "task",
      reason: "Observed billing failure",
      checkedAt: "2026-07-30T12:00:00.000Z",
    }]);
    expect(route.profileId).toBe("claude");
    expect(route.warnings[0]).toContain("Observed billing failure");
    expect(route.candidates.every(({ profileId }) => profileId === "claude")).toBe(true);
  });

  test("treats missing price as unknown and keeps candidate profiles visible", () => {
    const unknown: ModelInfo = {
      id: "sonnet",
      label: "Sonnet",
      provider: "claude",
      profileId: "claude",
      source: "configured",
    };
    const route = chooseModel("Review this codebase.", [unknown, ...models.slice(3)], profiles, {
      preference: "quality",
    });
    expect(route.candidates.some(({ profileId }) => profileId === "claude")).toBe(true);
    expect(route.candidates.some(({ profileId }) => profileId === "opencode")).toBe(true);
    expect(route.candidates.find(({ profileId }) => profileId === "claude")?.traits.costSource)
      .toBe("unknown");
  });

  test("applies task policy allow rules, preference, and minimum quality", () => {
    const route = chooseModel(
      "Implement the feature.",
      models,
      profiles,
      {},
      [],
      buildPolicy,
    );
    expect(route.model).toBe("opus");
    expect(route.preference).toBe("quality");
    expect(route.requiredQuality).toBe(5);
    expect(route.candidates.map(({ model }) => model)).toEqual(["opus"]);
    expect(route.warnings.some((warning) => warning.includes("sonnet"))).toBe(true);
  });

  test("applies policy only to its matching task class", () => {
    const route = chooseModel(
      "Architect a secure migration.",
      models,
      profiles,
      {},
      [],
      buildPolicy,
    );
    expect(route.taskClass).toBe("reasoning");
    expect(route.warnings.some((warning) => warning.includes("project policy"))).toBe(false);
  });

  test("allows Codex for reasoning while excluding it from build", () => {
    const codexProfile: Profile = {
      id: "codex",
      label: "Codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      enabled: true,
      env: {},
      capabilities: [],
    };
    const codexModel: ModelInfo = {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      provider: "codex",
      profileId: "codex",
      source: "configured",
    };
    const policy: RoutingPolicy = {
      ...buildPolicy,
      routes: {
        build: buildPolicy.routes.build,
        reasoning: {
          allow: [{ provider: "codex", model: "*" }],
        },
      },
    };
    const allProfiles = [...profiles, codexProfile];
    const allModels = [...models, codexModel];

    const build = chooseModel(
      "Implement the feature.",
      allModels,
      allProfiles,
      {},
      [],
      policy,
    );
    const reasoning = chooseModel(
      "Architect a secure migration.",
      allModels,
      allProfiles,
      {},
      [],
      policy,
    );

    expect(build.candidates.some(({ profileId }) => profileId === "codex")).toBe(false);
    expect(reasoning.profileId).toBe("codex");
  });

  test("uses local status to choose between profiles offering the same allowed model", () => {
    const duplicateProfiles: Profile[] = [
      { ...profiles[0]!, id: "claude-low" },
      { ...profiles[0]!, id: "claude-funded" },
    ];
    const duplicateModels: ModelInfo[] = duplicateProfiles.map((profile) => ({
      id: "opus",
      label: "Opus",
      provider: "claude",
      profileId: profile.id,
      source: "configured",
      cost: { input: 15, output: 75 },
    }));
    const statuses: ProfileStatus[] = [{
      profile: "claude-low",
      provider: "claude",
      model: "opus",
      state: "unavailable",
      source: "task",
      reason: "Observed billing failure",
      checkedAt: "2026-07-30T12:00:00.000Z",
    }, {
      profile: "claude-funded",
      provider: "claude",
      model: "opus",
      state: "available",
      source: "task",
      reason: "Observed successful generation",
      checkedAt: "2026-07-30T12:01:00.000Z",
    }];
    const route = chooseModel(
      "Implement the feature.",
      duplicateModels,
      duplicateProfiles,
      {},
      statuses,
      buildPolicy,
    );
    expect(route.profileId).toBe("claude-funded");
    expect(route.warnings[0]).toContain("claude-low/opus");
  });

  test("keeps unknown status eligible with a warning", () => {
    const unknown: ProfileStatus = {
      profile: "claude",
      provider: "claude",
      model: "opus",
      state: "unknown",
      source: "configuration",
      reason: "No observed generation outcome",
      checkedAt: "2026-07-30T12:00:00.000Z",
    };
    const route = chooseModel(
      "Implement the feature.",
      [models[2]!],
      [profiles[0]!],
      {},
      [unknown],
      buildPolicy,
    );
    expect(route.model).toBe("opus");
    expect(route.warnings[0]).toContain("availability unknown");
  });

  test("reports normalized retry time when status excludes a hinted model", () => {
    const retryAt = "2026-07-30T12:10:00.000Z";
    const unavailable: ProfileStatus = {
      profile: "opencode",
      provider: "opencode",
      model: "opencode/kimi-k3",
      state: "unavailable",
      source: "task",
      reason: "Observed rate limit",
      checkedAt: "2026-07-30T12:00:00.000Z",
      retryAt,
    };
    expect(() => chooseModel(
      "Implement the feature.",
      models,
      profiles,
      { modelHint: "kimi3" },
      [unavailable],
    )).toThrow(`model hint kimi3 has no eligible model for build; excluded model opencode/opencode/kimi-k3: Observed rate limit; retry at ${retryAt}`);
  });

  test("fails clearly when project policy excludes a hinted model", () => {
    expect(() => chooseModel(
      "Implement the feature.",
      models,
      profiles,
      { modelHint: "sonnet" },
      [],
      buildPolicy,
    )).toThrow("model hint sonnet has no eligible model for build");
  });
});
