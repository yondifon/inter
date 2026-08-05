import { describe, expect, test } from "bun:test";
import {
  checkNamedRoute,
  chooseModel,
  NoEligibleModelError,
  projectEffort,
} from "../src/model-router";
import type { ProfileStatus } from "../src/profile-status";
import type { RoutingPolicy } from "../src/routing-policy";
import type { ProfileUsage } from "../src/usage";
import type { ModelInfo, Profile, Provider } from "../src/types";

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

function spent(profile: string, provider: Provider, usedPercent: number): ProfileUsage {
  return {
    profile,
    provider,
    supported: true,
    source: provider === "claude" ? "claude-cli" : "codex-session-log",
    windows: [{ label: "Current session", kind: "session", usedPercent }],
  };
}

// What opencode, pi, and antigravity all return: no usage source at all.
function silent(profile: string, provider: Provider): ProfileUsage {
  return {
    profile,
    provider,
    supported: false,
    source: "none",
    windows: [],
    reason: "usage tracking is not supported",
  };
}

function unavailable(
  profile: string,
  provider: Provider,
  model: string,
  reason: string,
  retryAt?: string,
): ProfileStatus {
  return {
    profile,
    provider,
    model,
    state: "unavailable",
    source: "task",
    reason,
    checkedAt: "2026-08-05T00:00:00.000Z",
    ...(retryAt ? { retryAt } : {}),
  };
}

describe("the capability floor difficulty buys", () => {
  test("a small model may take mechanical work and may not take critical work", () => {
    const mechanical = chooseModel("Apply this diff.", models, profiles, { difficulty: "mechanical" });
    expect(mechanical.floor).toBe(2);
    expect(mechanical.model).toBe("haiku");

    const critical = chooseModel("Apply this diff.", models, profiles, { difficulty: "critical" });
    expect(critical.floor).toBe(5);
    expect(critical.model).toBe("opencode/kimi-k3");
    expect(critical.rejected.filter(({ stage }) => stage === "floor").map(({ model }) => model).sort())
      .toEqual(["haiku", "opencode/big-pickle", "sonnet"]);
    expect(critical.rejected.find(({ model }) => model === "haiku")?.reason)
      .toContain("below what critical work needs");
  });

  test("the floor gives way rather than refusing when nothing clears it", () => {
    const onlySmall = [models[0]!];
    const route = chooseModel("Apply this diff.", onlySmall, [profiles[0]!], { difficulty: "critical" });
    expect(route.model).toBe("haiku");
    expect(route.floorRelaxed).toBe(true);
    expect(route.floor).toBe(2);
    expect(route.warnings.some((warning) => warning.includes("ran the strongest one available")))
      .toBe(true);
  });

  test("the project policy raises the floor above the declared difficulty", () => {
    const policy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: { mechanical: { minQuality: 4, allow: [{ provider: "claude", model: "*" }] } },
    };
    const route = chooseModel("Rename this symbol.", models, profiles, { difficulty: "mechanical" }, [], policy);
    expect(route.floor).toBe(4);
    expect(route.model).toBe("sonnet");
  });
});

describe("the prompt heuristic as a cross-check", () => {
  test("records the disagreement and still dispatches as declared", () => {
    const route = chooseModel(
      "Architect a secure migration and analyze race conditions.",
      models,
      profiles,
      { difficulty: "mechanical" },
    );
    expect(route.taskClass).toBe("reasoning");
    expect(route.heuristicAgreed).toBe(false);
    expect(route.model).toBe("haiku");
    expect(route.warnings.some((warning) => warning.includes("raise difficulty"))).toBe(true);
  });

  test("records a disagreement with the default without warning about it", () => {
    // Most prompts read as `build` to the heuristic, which wants a stronger tier
    // than the standard default. Warning on all of them teaches callers to ignore
    // warnings; the record still carries the disagreement for later analysis.
    const route = chooseModel("Implement the feature.", models, profiles);
    expect(route.difficulty).toBe("standard");
    expect(route.heuristicAgreed).toBe(false);
    expect(route.warnings.some((warning) => warning.includes("raise difficulty"))).toBe(false);
  });

  test("agrees when the declaration is at least as strong as the heuristic", () => {
    const route = chooseModel(
      "Architect a secure migration and analyze race conditions.",
      models,
      profiles,
      { difficulty: "critical" },
    );
    expect(route.heuristicAgreed).toBe(true);
    expect(route.warnings.some((warning) => warning.includes("raise difficulty"))).toBe(false);
  });
});

describe("policy is the authority, and the catalog is the reality", () => {
  test("names an allow entry no connected account offers and selects from the rest", () => {
    const policy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: {
        build: {
          minQuality: 4,
          allow: [
            { provider: "claude", model: "opus-9" },
            { provider: "opencode", model: "opencode/kimi-k3" },
          ],
        },
      },
    };
    const route = chooseModel("Implement the feature.", models, profiles, {}, [], policy);
    expect(route.model).toBe("opencode/kimi-k3");
    expect(route.warnings.some((warning) =>
      warning.includes("claude model opus-9") && warning.includes("no connected account offers it")
    )).toBe(true);
  });

  test("refuses rather than selecting a model outside the allow list", () => {
    const policy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: { build: { allow: [{ provider: "claude", model: "opus-9" }] } },
    };
    let thrown: unknown;
    try {
      chooseModel("Implement the feature.", models, profiles, {}, [], policy);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoEligibleModelError);
    const failure = thrown as NoEligibleModelError;
    expect(failure.code).toBe("no_eligible_model");
    expect(failure.rejected.every(({ stage }) => stage === "policy")).toBe(true);
    expect(failure.message).toContain("no routable models are available");
  });

  test("allow order decides the model when the caller named only the account", () => {
    const ordered = (allow: Array<{ provider: string; model: string }>): RoutingPolicy => ({
      version: 1,
      path: "/project/.inter.toml",
      routes: { build: { minQuality: 3, allow } },
    });
    const kimiFirst = chooseModel("Implement the feature.", models, profiles, { profileId: "opencode" }, [], ordered([
      { provider: "opencode", model: "opencode/kimi-k3" },
      { provider: "opencode", model: "opencode/big-pickle" },
    ]));
    const pickleFirst = chooseModel("Implement the feature.", models, profiles, { profileId: "opencode" }, [], ordered([
      { provider: "opencode", model: "opencode/big-pickle" },
      { provider: "opencode", model: "opencode/kimi-k3" },
    ]));

    expect(kimiFirst.model).toBe("opencode/kimi-k3");
    expect(pickleFirst.model).toBe("opencode/big-pickle");
  });
});

describe("remaining usage", () => {
  test("drops an account with no usable window left from automatic routing", () => {
    const route = chooseModel("Implement the feature.", models, profiles, {}, [], undefined, [
      spent("claude", "claude", 99),
    ]);
    expect(route.profileId).toBe("opencode");
    expect(route.rejected.some(({ stage, profileId }) => stage === "quota" && profileId === "claude"))
      .toBe(true);
    expect(route.warnings.some((warning) => warning.includes("1% of its usage window left")))
      .toBe(true);
  });

  test("keeps the account the caller named, however little is left of it", () => {
    const route = chooseModel(
      "Implement the feature.",
      models,
      profiles,
      { profileId: "claude", difficulty: "hard" },
      [],
      undefined,
      [spent("claude", "claude", 99)],
    );
    expect(route.profileId).toBe("claude");
    expect(route.quotaUsedPercent).toBe(99);
    expect(route.rejected.some(({ stage }) => stage === "quota")).toBe(false);
    expect(route.warnings.some((warning) => warning.includes("too little to finish a task")))
      .toBe(true);
  });

  test("a provider reporting no usage is unknown headroom, neither spent nor free", () => {
    const route = chooseModel("Implement the feature.", models, profiles, {}, [], undefined, [
      spent("claude", "claude", 99),
      silent("opencode", "opencode"),
    ]);
    // Unknown never excludes: opencode stays selectable where a measured 99%
    // does not. It also earns no credit — the score is the same with the row
    // present and absent, so silence cannot be the cheapest thing to buy.
    expect(route.profileId).toBe("opencode");
    expect(route.quotaUsedPercent).toBeNull();
    expect(route.rejected.some(({ profileId }) => profileId === "opencode")).toBe(false);
    const withoutRow = chooseModel("Implement the feature.", models, profiles, {}, [], undefined, [
      spent("claude", "claude", 99),
    ]);
    expect(route.candidates[0]!.score).toBe(withoutRow.candidates[0]!.score);
  });
});

describe("when every candidate is filtered out", () => {
  test("the failure names each rejection and the earliest account back", () => {
    const statuses = [
      unavailable("claude", "claude", "haiku", "Observed rate limit", "2026-08-05T03:50:00.000Z"),
      unavailable("claude", "claude", "sonnet", "Observed rate limit", "2026-08-05T03:20:00.000Z"),
      unavailable("claude", "claude", "opus", "Observed rate limit", "2026-08-05T03:20:00.000Z"),
      unavailable("opencode", "opencode", "opencode/kimi-k3", "Observed billing failure"),
      unavailable("opencode", "opencode", "opencode/big-pickle", "Observed billing failure"),
    ];
    let thrown: unknown;
    try {
      chooseModel("Implement the feature.", models, profiles, {}, statuses);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoEligibleModelError);
    const failure = thrown as NoEligibleModelError;
    expect(failure.earliestRetryAt).toBe("2026-08-05T03:20:00.000Z");
    expect(failure.rejected).toHaveLength(5);
    expect(failure.rejected.every(({ stage }) => stage === "availability")).toBe(true);
    expect(failure.rejected.find(({ profileId }) => profileId === "opencode")?.reason)
      .toBe("Observed billing failure");
    expect(failure.message).toContain("2026-08-05T03:20:00.000Z");
  });
});

describe("effort read off the model's own ladder", () => {
  function ladder(efforts: string[] | undefined, provider: Provider = "claude"): ModelInfo {
    return {
      id: "model",
      label: "Model",
      provider,
      profileId: provider,
      source: "discovered",
      ...(efforts ? { efforts } : {}),
    };
  }

  test("projects difficulty onto a five-rung ladder", () => {
    const claude = ladder(["low", "medium", "high", "xhigh", "max"]);
    expect(projectEffort(claude, "mechanical").effort).toBe("medium");
    expect(projectEffort(claude, "standard").effort).toBe("xhigh");
    expect(projectEffort(claude, "hard").effort).toBe("max");
    expect(projectEffort(claude, "critical").effort).toBe("max");
  });

  test("projects onto a six-rung ladder without assuming five", () => {
    const pi = ladder(["minimal", "low", "medium", "high", "xhigh", "max"], "pi");
    expect(projectEffort(pi, "mechanical").effort).toBe("low");
    expect(projectEffort(pi, "hard").effort).toBe("max");
  });

  test("a ladder published out of order is sorted before anything projects onto it", () => {
    const codex = ladder(["high", "minimal", "medium"], "codex");
    expect(projectEffort(codex, "mechanical").effort).toBe("medium");
    expect(projectEffort(codex, "hard").effort).toBe("high");
  });

  test("a ladder using unknown words keeps the order the provider published", () => {
    const odd = ladder(["thinky", "thinkier"], "codex");
    const projected = projectEffort(odd, "hard");
    expect(projected.effort).toBe("thinkier");
    expect(projected.reason).toContain("published");
  });

  test("no ladder means no effort flag rather than an invented rung", () => {
    const projected = projectEffort(ladder(undefined, "opencode"), "hard");
    expect(projected.effort).toBeUndefined();
    expect(projected.reason).toContain("no reasoning levels");
  });

  test("the chosen model's effort rides the route", () => {
    const withLadder: ModelInfo[] = [{
      ...models[1]!,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    }];
    const route = chooseModel("Implement the feature.", withLadder, [profiles[0]!], {
      difficulty: "hard",
    });
    expect(route.effort).toBe("max");
    expect(route.effortReason).toContain("hard");
  });
});

describe("the caller-named pair is advised, never blocked", () => {
  const named = { profileId: "claude", model: "opus" };

  test("an account with a billing failure warns and still returns a plan", () => {
    const audit = checkNamedRoute("Implement the feature.", named, models, profiles, [
      unavailable("claude", "claude", "opus", "Observed billing failure"),
    ]);
    expect(audit.rejected).toEqual([{
      profileId: "claude",
      model: "opus",
      stage: "availability",
      reason: "Observed billing failure",
    }]);
    expect(audit.warnings.some((warning) =>
      warning.includes("claude is unavailable") && warning.includes("Dispatching anyway")
    )).toBe(true);
  });

  test("a model the account does not list warns without guessing another one", () => {
    const audit = checkNamedRoute(
      "Implement the feature.",
      { profileId: "claude", model: "opus-9" },
      models,
      profiles,
    );
    expect(audit.rejected.map(({ stage }) => stage)).toEqual(["catalog"]);
    expect(audit.warnings.some((warning) => warning.includes("does not list a model called opus-9")))
      .toBe(true);
    expect(audit.effort).toBeUndefined();
  });

  test("a catalog that is only the configured fallback claims nothing about the model", () => {
    // Model discovery that fails leaves one configured entry behind. Reading that
    // as the account's whole catalog would warn about every other model it has.
    const fallback: ModelInfo[] = [{
      id: "sonnet",
      label: "sonnet",
      provider: "claude",
      profileId: "claude",
      source: "configured",
    }];
    const audit = checkNamedRoute("Implement the feature.", named, fallback, profiles);
    expect(audit.rejected).toEqual([]);
    expect(audit.warnings).toEqual([]);
  });

  test("a pair outside project policy warns that the choice overrode it", () => {
    const policy: RoutingPolicy = {
      version: 1,
      path: "/project/.inter.toml",
      routes: { build: { allow: [{ provider: "opencode", model: "opencode/kimi-k3" }] } },
    };
    const audit = checkNamedRoute("Implement the feature.", named, models, profiles, [], policy);
    expect(audit.rejected.map(({ stage }) => stage)).toEqual(["policy"]);
    expect(audit.warnings.some((warning) => warning.includes("overrode the project's routing policy")))
      .toBe(true);
    expect(audit.policyPath).toBe("/project/.inter.toml");
  });

  test("an account with almost nothing left warns and is still dispatched to", () => {
    const audit = checkNamedRoute("Implement the feature.", named, models, profiles, [], undefined, [
      spent("claude", "claude", 99),
    ]);
    expect(audit.quotaUsedPercent).toBe(99);
    expect(audit.rejected.map(({ stage }) => stage)).toEqual(["quota"]);
    expect(audit.warnings.some((warning) => warning.includes("1% of its usage window left")))
      .toBe(true);
  });

  test("a caller effort the model does not accept is warned about, not dropped", () => {
    const withLadder = models.map((model) =>
      model.id === "opus" ? { ...model, efforts: ["low", "medium", "high"] } : model
    );
    const audit = checkNamedRoute(
      "Implement the feature.",
      { ...named, effort: "max" },
      withLadder,
      profiles,
    );
    expect(audit.warnings.some((warning) =>
      warning.includes("accepts low, medium, high") && warning.includes("passing it through")
    )).toBe(true);
  });

  test("a clean named pair produces no findings and still reads its effort", () => {
    const withLadder = models.map((model) =>
      model.id === "opus" ? { ...model, efforts: ["low", "medium", "high", "xhigh", "max"] } : model
    );
    const audit = checkNamedRoute(
      "Rename this symbol in two files.",
      { ...named, difficulty: "mechanical" },
      withLadder,
      profiles,
    );
    expect(audit.rejected).toEqual([]);
    expect(audit.warnings).toEqual([]);
    expect(audit.effort).toBe("medium");
  });
});
