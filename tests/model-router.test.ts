import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseModel, classifyTask, modelTraits, routeModel } from "../src/model-router";
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
  test("reads the project policy from the supplied cwd, never the broker's", async () => {
    const root = mkdtempSync(join(tmpdir(), "inter-router-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "inter-router-elsewhere-"));
    // Routing merges `~/.inter.toml` as its user layer; an empty temp home
    // keeps `elsewhere` genuinely unpoliced whatever this machine's dotfiles say.
    const home = mkdtempSync(join(tmpdir(), "inter-router-home-"));
    const previousCwd = process.cwd();
    const previousDb = process.env.INTER_DB;
    const previousHome = process.env.HOME;
    writeFileSync(join(root, ".inter.toml"), `
version = 1
[routes.build]
allow = [{ provider = "claude", model = "opus" }]
`);

    try {
      closeStateStore();
      process.env.HOME = home;
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
      // Park the broker inside the policy directory. Only the cwd passed by the
      // caller may decide routing, so `elsewhere` must stay unpoliced.
      process.chdir(root);

      await expect(routeModel("Implement the fix.", { cwd: root }))
        .rejects.toThrow("no routable models are available");
      const unpoliced = await routeModel("Implement the fix.", { cwd: elsewhere });
      expect(unpoliced.reason).not.toContain("applied project policy");
    } finally {
      closeStateStore();
      process.chdir(previousCwd);
      if (previousDb === undefined) delete process.env.INTER_DB;
      else process.env.INTER_DB = previousDb;
      process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("uses a cheap model for bounded mechanical work", () => {
    const route = chooseModel("Rename this variable in two files.", models, profiles, {
      difficulty: "mechanical",
    });
    expect(route.taskClass).toBe("mechanical");
    expect(route.model).toBe("haiku");
  });

  test("deprioritizes profiles deep into a rate-limit window", () => {
    const claudeNearLimit = {
      profile: "claude",
      provider: "claude" as const,
      supported: true,
      source: "claude-cli" as const,
      windows: [{ label: "Current session", kind: "session" as const, usedPercent: 96 }],
    };
    const baseline = chooseModel("Rename this variable in two files.", models, profiles, {
      difficulty: "mechanical",
    });
    expect(baseline.model).toBe("haiku");
    const route = chooseModel(
      "Rename this variable in two files.",
      models,
      profiles,
      { difficulty: "mechanical" },
      [],
      undefined,
      [claudeNearLimit],
    );
    expect(route.profileId).toBe("opencode");
    expect(route.warnings.some((warning) =>
      warning.startsWith("claude is 96% into the rate-limit window covering") &&
      warning.endsWith("; deprioritized")
    )).toBe(true);
  });

  test("an exhausted model window leaves the account's other models routable", () => {
    const opusExhausted = {
      profile: "claude",
      provider: "claude" as const,
      supported: true,
      source: "claude-cli" as const,
      windows: [
        { label: "Current session", kind: "session" as const, usedPercent: 15 },
        { label: "Current week (Opus)", kind: "week" as const, usedPercent: 99, model: "opus" },
      ],
    };
    const route = chooseModel(
      "Rename this variable in two files.",
      models,
      profiles,
      { difficulty: "mechanical" },
      [],
      undefined,
      [opusExhausted],
    );
    expect(route.model).toBe("haiku");
    expect(route.quotaUsedPercent).toBe(15);
    expect(route.rejected.some(({ model, stage }) => model === "opus" && stage === "quota")).toBe(true);
    expect(route.rejected.some(({ model, stage }) => model === "haiku" && stage === "quota")).toBe(false);
  });

  test("uses stronger context comprehension for codebase reading", () => {
    const route = chooseModel("Read these files and understand how auth works.", models, profiles, {
      difficulty: "hard",
    });
    expect(route.taskClass).toBe("context");
    expect(route.candidates[0]!.traits.quality).toBeGreaterThanOrEqual(4);
  });

  test("will not let low price beat required architecture quality", () => {
    const route = chooseModel("Architect a secure migration and analyze race conditions.", models, profiles, {
      preference: "cost",
      difficulty: "critical",
    });
    expect(route.floor).toBe(5);
    expect(route.candidates[0]!.traits.quality).toBe(5);
  });

  test("resolves friendly model hints without a profile lookup", () => {
    const route = chooseModel("Implement the fix.", models, profiles, { modelHint: "kimi3" });
    expect(route.model).toBe("opencode/kimi-k3");
    expect(route.profileId).toBe("opencode");
  });

  test("picks a named profile's best model for the class by allow order", () => {
    // The allow list puts kimi-k3 ahead of big-pickle, so naming the profile
    // must yield kimi-k3 even though it is not the profile's static default.
    const orderedPolicy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: {
        build: {
          preference: "quality",
          minQuality: 4,
          allow: [
            { provider: "opencode", model: "opencode/kimi-k3" },
            { provider: "opencode", model: "opencode/big-pickle" },
          ],
        },
      },
    };
    const route = chooseModel(
      "Implement the feature.",
      models,
      profiles,
      { profileId: "opencode" },
      [],
      orderedPolicy,
    );

    expect(route.profileId).toBe("opencode");
    expect(route.model).toBe("opencode/kimi-k3");
  });

  test("falls to the next allowed model when the profile's first choice is down", () => {
    const orderedPolicy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: {
        build: {
          preference: "quality",
          minQuality: 4,
          allow: [
            { provider: "opencode", model: "opencode/kimi-k3" },
            { provider: "opencode", model: "opencode/big-pickle" },
          ],
        },
      },
    };
    const route = chooseModel(
      "Implement the feature.",
      models,
      profiles,
      { profileId: "opencode" },
      [{
        profile: "opencode",
        provider: "opencode",
        model: "opencode/kimi-k3",
        state: "unavailable",
        source: "task",
        reason: "Observed rate limit",
        checkedAt: "2026-08-02T00:00:00.000Z",
      }],
      orderedPolicy,
    );

    expect(route.model).toBe("opencode/big-pickle");
  });

  test("leaves automatic routing score-driven so the usage penalty still wins", () => {
    // No profileId: allow order must not override the rate-limit deprioritization.
    const claudeSpent = {
      profile: "claude",
      provider: "claude" as const,
      supported: true,
      source: "claude-cli" as const,
      windows: [{ label: "Current session", kind: "session" as const, usedPercent: 96 }],
    };
    const route = chooseModel(
      "Implement the feature.",
      models,
      profiles,
      {},
      [],
      {
        version: 1,
        path: "/project/.inter.toml",
        routes: {
          build: {
            minQuality: 4,
            allow: [
              { provider: "claude", model: "opus" },
              { provider: "opencode", model: "opencode/kimi-k3" },
            ],
          },
        },
      },
      [claudeSpent],
    );

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
    expect(route.floor).toBe(5);
    expect(route.candidates.map(({ model }) => model)).toEqual(["opus"]);
    expect(route.warnings.some((warning) => warning.startsWith("excluded ") &&
      warning.includes("project policy route build"))).toBe(true);
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

describe("model traits", () => {
  function traitsFor(id: string) {
    return modelTraits({
      id,
      label: id,
      provider: "opencode",
      profileId: "opencode",
      source: "discovered",
    });
  }

  test("a flash name still marks a small tier", () => {
    expect(traitsFor("opencode-go/gemini-3.6-flash-low").quality).toBe(2);
    expect(traitsFor("haiku").quality).toBe(2);
  });

  test("deepseek-v4-flash is an everyday model despite the flash name", () => {
    // At the name-derived 2 it fell under min_quality for every route class,
    // so no policy listing could ever select it.
    const traits = traitsFor("opencode-go/deepseek-v4-flash");
    expect(traits.quality).toBe(4);
    // Still genuinely fast; only the quality read was wrong.
    expect(traits.speed).toBe(5);
  });
});
