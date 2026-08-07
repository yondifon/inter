import { describe, expect, test } from "bun:test";
import {
  listProfileStatuses,
  normalizeProfileStatuses,
} from "../src/profile-status";
import type { ProfileFailure, ProfileSuccess } from "../src/store";
import type { ModelInfo, Profile } from "../src/types";

const profile: Profile = {
  id: "claude-work",
  label: "Claude work",
  provider: "claude",
  model: "opus",
  enabled: true,
  env: { CLAUDE_CONFIG_DIR: "secret-path" },
  capabilities: ["build"],
};

const model: ModelInfo = {
  id: "opus",
  label: "Opus",
  provider: "claude",
  profileId: profile.id,
  source: "configured",
};

const now = new Date("2026-07-30T12:00:00.000Z");

describe("profile status normalization", () => {
  test("keeps unknown models routable and reports no secret profile fields", () => {
    const [status] = normalizeProfileStatuses([profile], [model], [], [], now);
    expect(status).toEqual({
      profile: profile.id,
      provider: "claude",
      model: "opus",
      state: "unknown",
      source: "configuration",
      reason: "No observed generation outcome",
      checkedAt: now.toISOString(),
    });
    expect(JSON.stringify(status)).not.toContain("secret-path");
    expect(status).not.toHaveProperty("env");
  });

  test("keeps auth and billing failures unavailable after catalog refresh", () => {
    for (const code of ["auth", "billing"] as const) {
      const failure: ProfileFailure = {
        profileId: profile.id,
        code,
        message: "token=must-not-leak",
        failedAt: "2026-07-30T11:00:00.000Z",
        consecutiveFailures: 1,
      };
      const [status] = normalizeProfileStatuses(
        [profile],
        [model],
        [failure],
        [],
        now,
        true,
      );
      expect(status?.state).toBe("unavailable");
      expect(status?.source).toBe("task");
      expect(JSON.stringify(status)).not.toContain(failure.message);
    }
  });

  test("uses explicit rate-limit retry semantics", () => {
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "rate_limit",
      message: "429",
      failedAt: "2026-07-30T11:55:00.000Z",
      consecutiveFailures: 1,
      retryAt: "2026-07-30T12:05:00.000Z",
    };
    const [blocked] = normalizeProfileStatuses([profile], [model], [failure], [], now);
    expect(blocked).toMatchObject({
      state: "unavailable",
      retryAt: failure.retryAt,
    });

    const [retryable] = normalizeProfileStatuses(
      [profile],
      [model],
      [failure],
      [],
      new Date("2026-07-30T12:06:00.000Z"),
    );
    expect(retryable).toMatchObject({
      state: "unknown",
      retryAt: failure.retryAt,
    });
  });

  test("uses shorter network retry semantics and surfaces the underlying error", () => {
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "network",
      message: 'dial tcp [2c0f:fb50::1]:443: i/o timeout',
      failedAt: "2026-07-30T11:55:00.000Z",
      consecutiveFailures: 1,
      retryAt: "2026-07-30T12:05:00.000Z",
    };
    const [blocked] = normalizeProfileStatuses([profile], [model], [failure], [], now);
    expect(blocked).toMatchObject({
      state: "unavailable",
      retryAt: failure.retryAt,
    });
    expect(blocked?.reason).toContain(failure.message);

    const [retryable] = normalizeProfileStatuses(
      [profile],
      [model],
      [failure],
      [],
      new Date("2026-07-30T12:06:00.000Z"),
    );
    expect(retryable).toMatchObject({
      state: "unknown",
      retryAt: failure.retryAt,
    });
  });

  test("successful generation marks catalog models available", () => {
    const successes: ProfileSuccess[] = [{
      profileId: profile.id,
      succeededAt: "2026-07-30T11:59:00.000Z",
    }];
    const [status] = normalizeProfileStatuses([profile], [model], [], successes, now, true);
    expect(status).toMatchObject({
      state: "available",
      source: "task",
      checkedAt: successes[0]!.succeededAt,
    });
  });

  test("a later success retires a failure the settle path never cleared", () => {
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "auth",
      message: "invalid api key",
      failedAt: "2026-07-30T09:00:00.000Z",
      consecutiveFailures: 4,
    };
    const after: ProfileSuccess[] = [{ profileId: profile.id, succeededAt: "2026-07-30T11:00:00.000Z" }];
    expect(normalizeProfileStatuses([profile], [model], [failure], after, now)[0]).toMatchObject({
      state: "available",
      reason: "Observed successful generation",
      checkedAt: after[0]!.succeededAt,
    });

    // The order is what decides it, not the mere existence of a success.
    const before: ProfileSuccess[] = [{ profileId: profile.id, succeededAt: "2026-07-30T08:00:00.000Z" }];
    expect(normalizeProfileStatuses([profile], [model], [failure], before, now)[0]).toMatchObject({
      state: "unavailable",
      reason: "Observed authentication failure",
    });
  });

  test("a rate limit takes out the model that hit it, not the whole account", () => {
    const fable: ModelInfo = { ...model, id: "fable", label: "Fable" };
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "rate_limit",
      message: "429",
      failedAt: "2026-07-30T11:55:00.000Z",
      consecutiveFailures: 1,
      retryAt: "2026-07-30T12:05:00.000Z",
      model: "fable",
    };
    const statuses = normalizeProfileStatuses([profile], [model, fable], [failure], [], now);
    expect(statuses.find(({ model: id }) => id === "fable")).toMatchObject({ state: "unavailable" });
    expect(statuses.find(({ model: id }) => id === "opus")).toMatchObject({ state: "unknown" });
  });

  test("keeps an unattributed rate limit account-wide", () => {
    const fable: ModelInfo = { ...model, id: "fable", label: "Fable" };
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "rate_limit",
      message: "429",
      failedAt: "2026-07-30T11:55:00.000Z",
      consecutiveFailures: 1,
      retryAt: "2026-07-30T12:05:00.000Z",
    };
    const statuses = normalizeProfileStatuses([profile], [model, fable], [failure], [], now);
    expect(statuses.map(({ state }) => state)).toEqual(["unavailable", "unavailable"]);
  });

  test("keeps auth failures account-wide even when a model is on record", () => {
    const fable: ModelInfo = { ...model, id: "fable", label: "Fable" };
    const failure: ProfileFailure = {
      profileId: profile.id,
      code: "auth",
      message: "invalid api key",
      failedAt: "2026-07-30T11:00:00.000Z",
      consecutiveFailures: 1,
      model: "fable",
    };
    const statuses = normalizeProfileStatuses([profile], [model, fable], [failure], [], now);
    expect(statuses.map(({ state }) => state)).toEqual(["unavailable", "unavailable"]);
  });

  test("refresh only invokes model catalog discovery", async () => {
    const queries: unknown[] = [];
    const statuses = await listProfileStatuses(
      { profile: profile.id, model: model.id, refresh: true },
      {
        loadProfiles: async () => [profile],
        listModels: async (query) => {
          queries.push(query);
          return [model];
        },
        listProfileFailures: () => [],
        listProfileSuccesses: () => [],
        now: () => now,
      },
    );
    expect(queries).toEqual([{ profile: profile.id, refresh: true }]);
    expect(statuses[0]).toMatchObject({
      state: "unknown",
      source: "catalog",
    });
  });
});
