import { homedir } from "node:os";
import { loadConfig, profileEnv } from "./config";
import { stateStore, type ProfileFailure } from "./store";
import type { Profile, Provider, TaskSummary } from "./types";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; usage: ProfileUsage }>();

export interface UsageWindow {
  label: string;
  kind: "session" | "week" | "other";
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
  resetsText?: string;
}

export interface ProfileUsage {
  profile: string;
  provider: Provider;
  supported: boolean;
  source: "claude-cli" | "codex-session-log" | "none";
  windows: UsageWindow[];
  plan?: string;
  observedAt?: string;
  reason?: string;
  lastRateLimit?: {
    message: string;
    failedAt: string;
    consecutiveFailures: number;
    retryAt?: string;
  };
  observedRateLimits?: Array<{
    upstream: string;
    model: string;
    failedAt: string;
    hits: number;
  }>;
}

export interface UsageQuery {
  profile?: string;
  provider?: Provider;
  refresh?: boolean;
}

export async function listProfileUsage(query: UsageQuery = {}): Promise<ProfileUsage[]> {
  const config = await loadConfig();
  const profiles = config.profiles.filter((profile) =>
    profile.enabled &&
    (!query.profile || profile.id === query.profile) &&
    (!query.provider || profile.provider === query.provider)
  );
  if (query.profile && profiles.length === 0) throw new Error(`unknown or disabled profile: ${query.profile}`);
  const failures = stateStore().listProfileFailures();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await Promise.all(profiles.map((profile) => usageForProfile(profile, query.refresh)));
  return rows.map((row) => withUpstreamRateLimits(
    withObservedRateLimit(row, failures),
    stateStore().listTaskSummaries({ profile: row.profile, state: "failed", since, limit: 100 }),
  ));
}

// Opencode fans out to separate upstream accounts (openai/…, opencode/…,
// ollama-cloud/…); the model prefix identifies which one was limited.
export function withUpstreamRateLimits(
  usage: ProfileUsage,
  failedTasks: Array<Pick<TaskSummary, "model" | "updatedAt" | "completion">>,
): ProfileUsage {
  const groups = new Map<string, { upstream: string; model: string; failedAt: string; hits: number }>();
  for (const task of failedTasks) {
    if (task.completion?.code !== "rate_limit") continue;
    const upstream = usage.provider === "opencode" && task.model.includes("/")
      ? task.model.split("/")[0]!
      : usage.provider;
    const entry = groups.get(upstream);
    if (!entry) {
      groups.set(upstream, { upstream, model: task.model, failedAt: task.updatedAt, hits: 1 });
      continue;
    }
    entry.hits += 1;
    if (task.updatedAt > entry.failedAt) {
      entry.failedAt = task.updatedAt;
      entry.model = task.model;
    }
  }
  if (groups.size === 0) return usage;
  return {
    ...usage,
    observedRateLimits: [...groups.values()].sort((a, b) => b.failedAt.localeCompare(a.failedAt)),
  };
}

export function withObservedRateLimit(usage: ProfileUsage, failures: ProfileFailure[]): ProfileUsage {
  const failure = failures.find(({ profileId, code }) => profileId === usage.profile && code === "rate_limit");
  if (!failure) return usage;
  return {
    ...usage,
    lastRateLimit: {
      message: failure.message,
      failedAt: failure.failedAt,
      consecutiveFailures: failure.consecutiveFailures,
      ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
    },
  };
}

async function usageForProfile(profile: Profile, refresh = false): Promise<ProfileUsage> {
  const cached = cache.get(profile.id);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.usage;
  const usage = await collect(profile);
  cache.set(profile.id, { at: Date.now(), usage });
  return usage;
}

async function collect(profile: Profile): Promise<ProfileUsage> {
  switch (profile.provider) {
    case "claude":
      return claudeUsage(profile);
    case "codex":
      return codexUsage(profile);
    case "opencode":
      return unsupported(profile, "usage tracking is not supported for opencode");
    case "antigravity":
      return unsupported(profile, "no usage source known for antigravity");
  }
}

// `claude -p "/usage"` runs as a local command: zero API turns, zero cost.
async function claudeUsage(profile: Profile): Promise<ProfileUsage> {
  let stdout: string;
  try {
    const child = Bun.spawn(["claude", "-p", "/usage", "--output-format", "json"], {
      env: { ...Bun.env, ...profileEnv(profile) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    if (exitCode !== 0) return unsupported(profile, `claude /usage exited with code ${exitCode}`);
    stdout = text;
  } catch (error) {
    return unsupported(profile, `claude /usage failed: ${String(error)}`);
  }
  const windows = parseClaudeUsage(claudeResultText(stdout));
  if (windows.length === 0) return unsupported(profile, "claude /usage returned no limit lines");
  return {
    profile: profile.id,
    provider: profile.provider,
    supported: true,
    source: "claude-cli",
    windows,
    observedAt: new Date().toISOString(),
  };
}

function claudeResultText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: string };
    return typeof parsed.result === "string" ? parsed.result : "";
  } catch {
    return "";
  }
}

export function parseClaudeUsage(text: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(.+?):\s+(\d+)% used(?:\s*·\s*resets\s+(.+))?$/);
    if (!match) continue;
    const label = match[1]!.trim();
    windows.push({
      label,
      kind: /session/i.test(label) ? "session" : /week/i.test(label) ? "week" : "other",
      usedPercent: Number(match[2]),
      ...(match[3] ? { resetsText: match[3].trim() } : {}),
    });
  }
  return windows;
}

// Codex logs `token_count` events with rate_limits into every session rollout.
async function codexUsage(profile: Profile): Promise<ProfileUsage> {
  const env = profileEnv(profile);
  const home = env.CODEX_HOME ?? Bun.env.CODEX_HOME ?? `${homedir()}/.codex`;
  let files: string[] = [];
  try {
    const glob = new Bun.Glob("sessions/**/rollout-*.jsonl");
    for await (const rel of glob.scan({ cwd: home })) files.push(rel);
  } catch {}
  // Rollout paths embed their timestamp, so a lexicographic sort is newest-last.
  files = files.sort().reverse().slice(0, 5);
  for (const rel of files) {
    const found = await rateLimitsFromRollout(`${home}/${rel}`);
    if (found) {
      return { profile: profile.id, provider: profile.provider, supported: true, source: "codex-session-log", ...found };
    }
  }
  return unsupported(profile, `no rate_limits events in recent session logs under ${home}/sessions`);
}

async function rateLimitsFromRollout(path: string): Promise<Pick<ProfileUsage, "windows" | "plan" | "observedAt"> | undefined> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return undefined;
  }
  const lines = raw.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"rate_limits"')) continue;
    const parsed = parseCodexRateLimits(line);
    if (parsed) return parsed;
  }
  return undefined;
}

export function parseCodexRateLimits(
  line: string,
): Pick<ProfileUsage, "windows" | "plan" | "observedAt"> | undefined {
  try {
    const event = JSON.parse(line) as {
      timestamp?: string;
      payload?: {
        rate_limits?: {
          primary?: CodexWindow | null;
          secondary?: CodexWindow | null;
          plan_type?: string | null;
        };
      };
    };
    const limits = event.payload?.rate_limits;
    if (!limits) return undefined;
    const windows = [
      codexWindow("primary", limits.primary),
      codexWindow("secondary", limits.secondary),
    ].filter((window): window is UsageWindow => Boolean(window));
    if (windows.length === 0) return undefined;
    return {
      windows,
      ...(limits.plan_type ? { plan: limits.plan_type } : {}),
      ...(event.timestamp ? { observedAt: event.timestamp } : {}),
    };
  } catch {
    return undefined;
  }
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

function codexWindow(label: string, window: CodexWindow | null | undefined): UsageWindow | undefined {
  if (!window || typeof window.used_percent !== "number") return undefined;
  const minutes = window.window_minutes;
  return {
    label,
    kind: minutes === undefined ? "other" : minutes >= 10_080 ? "week" : minutes <= 720 ? "session" : "other",
    usedPercent: window.used_percent,
    ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
    ...(typeof window.resets_at === "number"
      ? { resetsAt: new Date(window.resets_at * 1000).toISOString() }
      : {}),
  };
}

export function worstWindowUsedPercent(usage: ProfileUsage): number | undefined {
  if (usage.windows.length === 0) return undefined;
  return Math.max(...usage.windows.map(({ usedPercent }) => usedPercent));
}

function unsupported(profile: Profile, reason: string): ProfileUsage {
  return {
    profile: profile.id,
    provider: profile.provider,
    supported: false,
    source: "none",
    windows: [],
    reason,
  };
}
