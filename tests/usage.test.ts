import { describe, expect, test } from "bun:test";
import {
  parseClaudeUsage,
  parseCodexRateLimits,
  withObservedRateLimit,
  withUpstreamRateLimits,
  type ProfileUsage,
} from "../src/usage";

describe("claude usage parsing", () => {
  test("extracts session and week windows with reset text", () => {
    const text = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 59% used · resets Jul 31 at 2:29am (Africa/Douala)",
      "Current week (all models): 20% used · resets Aug 2 at 3:59pm (Africa/Douala)",
      "",
      "Last 24h · 296 requests · 13 sessions",
    ].join("\n");
    expect(parseClaudeUsage(text)).toEqual([
      {
        label: "Current session",
        kind: "session",
        usedPercent: 59,
        resetsText: "Jul 31 at 2:29am (Africa/Douala)",
      },
      {
        label: "Current week (all models)",
        kind: "week",
        usedPercent: 20,
        resetsText: "Aug 2 at 3:59pm (Africa/Douala)",
      },
    ]);
  });

  test("keeps windows without reset text and ignores prose", () => {
    expect(parseClaudeUsage("Current week (Opus): 5% used\n83% of your usage was at >150k context"))
      .toEqual([{ label: "Current week (Opus)", kind: "week", usedPercent: 5 }]);
  });

  test("returns nothing for unusable output", () => {
    expect(parseClaudeUsage("")).toEqual([]);
    expect(parseClaudeUsage("no limits here")).toEqual([]);
  });
});

describe("codex rate limit parsing", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-30T22:17:06.816Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 77, window_minutes: 10_080, resets_at: 1_785_922_641 },
        secondary: null,
        plan_type: "team",
      },
    },
  });

  test("extracts windows, plan, and timestamps from a token_count line", () => {
    expect(parseCodexRateLimits(line)).toEqual({
      windows: [{
        label: "primary",
        kind: "week",
        usedPercent: 77,
        windowMinutes: 10_080,
        resetsAt: new Date(1_785_922_641 * 1000).toISOString(),
      }],
      plan: "team",
      observedAt: "2026-07-30T22:17:06.816Z",
    });
  });

  test("labels five-hour windows as session", () => {
    const parsed = parseCodexRateLimits(JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 12, window_minutes: 300 } } },
    }));
    expect(parsed?.windows).toEqual([{ label: "primary", kind: "session", usedPercent: 12, windowMinutes: 300 }]);
  });

  test("attaches observed rate-limit failures to the matching profile", () => {
    const usage: ProfileUsage = {
      profile: "opencode",
      provider: "opencode",
      supported: false,
      source: "none",
      windows: [],
    };
    const failure = {
      profileId: "opencode",
      code: "rate_limit" as const,
      message: "Rate limit exceeded. Please try again later.",
      failedAt: "2026-07-30T20:00:00.000Z",
      consecutiveFailures: 2,
      retryAt: "2026-07-30T20:10:00.000Z",
    };
    expect(withObservedRateLimit(usage, [failure])).toEqual({
      ...usage,
      lastRateLimit: {
        message: failure.message,
        failedAt: failure.failedAt,
        consecutiveFailures: 2,
        retryAt: failure.retryAt,
      },
    });
    expect(withObservedRateLimit(usage, [{ ...failure, code: "auth" as const }])).toEqual(usage);
    expect(withObservedRateLimit(usage, [{ ...failure, profileId: "codex" }])).toEqual(usage);
  });

  test("ignores lines without usable rate limits", () => {
    expect(parseCodexRateLimits("not json")).toBeUndefined();
    expect(parseCodexRateLimits(JSON.stringify({ payload: { type: "token_count" } }))).toBeUndefined();
    expect(parseCodexRateLimits(JSON.stringify({ payload: { rate_limits: { primary: null, secondary: null } } })))
      .toBeUndefined();
  });
});

describe("upstream rate limit grouping", () => {
  const usage: ProfileUsage = {
    profile: "opencode",
    provider: "opencode",
    supported: false,
    source: "none",
    windows: [],
  };
  const rateLimited = (model: string, updatedAt: string) => ({
    model,
    updatedAt,
    completion: { blocked: false, code: "rate_limit" as const },
  });

  test("groups opencode failures by model namespace prefix", () => {
    const result = withUpstreamRateLimits(usage, [
      rateLimited("openai/gpt-5.5", "2026-07-30T10:00:00.000Z"),
      rateLimited("openai/gpt-5.6-luna", "2026-07-30T12:00:00.000Z"),
      rateLimited("opencode-go/glm-5.1", "2026-07-30T11:00:00.000Z"),
      { model: "ollama-cloud/kimi-k3", updatedAt: "2026-07-30T13:00:00.000Z", completion: { blocked: false, code: "worker_error" as const } },
    ]);
    expect(result.observedRateLimits).toEqual([
      { upstream: "openai", model: "openai/gpt-5.6-luna", failedAt: "2026-07-30T12:00:00.000Z", hits: 2 },
      { upstream: "opencode-go", model: "opencode-go/glm-5.1", failedAt: "2026-07-30T11:00:00.000Z", hits: 1 },
    ]);
  });

  test("uses the provider as upstream for claude and codex", () => {
    const claude = { ...usage, profile: "default", provider: "claude" as const };
    expect(withUpstreamRateLimits(claude, [rateLimited("opus", "2026-07-30T10:00:00.000Z")]).observedRateLimits)
      .toEqual([{ upstream: "claude", model: "opus", failedAt: "2026-07-30T10:00:00.000Z", hits: 1 }]);
  });

  test("leaves usage untouched without rate-limited tasks", () => {
    expect(withUpstreamRateLimits(usage, [])).toEqual(usage);
  });
});
