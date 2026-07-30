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
