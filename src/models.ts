import { loadConfig, profileEnv } from "./config";
import type { ModelInfo, Profile, Provider } from "./types";

const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; models: ModelInfo[] }>();
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku", "fable"];

export interface ModelQuery {
  profile?: string;
  provider?: Provider;
  refresh?: boolean;
}

export async function listModels(query: ModelQuery = {}): Promise<ModelInfo[]> {
  const config = await loadConfig();
  const profiles = config.profiles.filter((profile) =>
    profile.enabled &&
    (!query.profile || profile.id === query.profile) &&
    (!query.provider || profile.provider === query.provider)
  );
  if (query.profile && profiles.length === 0) throw new Error(`unknown or disabled profile: ${query.profile}`);
  return (await Promise.all(profiles.map((profile) => modelsForProfile(profile, query.refresh))))
    .flat()
    .sort((a, b) => a.profileId.localeCompare(b.profileId) || a.id.localeCompare(b.id));
}

async function modelsForProfile(profile: Profile, refresh = false): Promise<ModelInfo[]> {
  const cached = cache.get(profile.id);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const models = await discover(profile);
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  cache.set(profile.id, { at: Date.now(), models: unique });
  return unique;
}

async function discover(profile: Profile): Promise<ModelInfo[]> {
  if (profile.provider === "claude") {
    return [...new Set([profile.model, ...CLAUDE_ALIASES])].map((id) =>
      model(profile, id, id, id === profile.model ? "configured" : "alias"));
  }

  const command = profile.provider === "codex"
    ? ["codex", "debug", "models"]
    : profile.provider === "antigravity"
    ? ["agy", "models"]
    : ["opencode", "models", "--verbose"];
  try {
    const output = await run(command, profile);
    const discovered = profile.provider === "codex"
      ? parseCodexModels(output, profile)
      : profile.provider === "antigravity"
      ? parseAntigravityModels(output, profile)
      : parseOpenCodeModels(output, profile);
    if (discovered.length > 0) return discovered;
  } catch {}
  return [model(profile, profile.model, profile.model, "configured")];
}

async function run(command: string[], profile: Profile): Promise<string> {
  const child = Bun.spawn(command, {
    env: { ...Bun.env, ...profileEnv(profile) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(`${profile.provider} model discovery failed`);
  if (stdout.length > 5_000_000) throw new Error(`${profile.provider} model catalog too large`);
  return stdout;
}

export function parseCodexModels(raw: string, profile: Profile): ModelInfo[] {
  const parsed = JSON.parse(raw) as {
    models?: Array<{
      slug?: string;
      display_name?: string;
      visibility?: string;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
    }>;
  };
  return (parsed.models ?? [])
    .filter((item) => item.slug && item.visibility !== "hidden")
    .map((item) =>
      model(
        profile,
        item.slug!,
        item.display_name || item.slug!,
        "discovered",
        parseEfforts(item.supported_reasoning_levels, item.default_reasoning_level),
      )
    );
}

/// Codex publishes an effort ladder per model. Entries arrive as objects
/// carrying an effort id and a description; only the id is needed to dispatch,
/// so the description is dropped rather than stored and never used.
function parseEfforts(supported: unknown, fallback: unknown): Partial<ModelInfo> {
  const levels = Array.isArray(supported)
    ? supported
      .map((level) => {
        if (typeof level === "string") return level;
        const effort = (level as { effort?: unknown } | null)?.effort;
        return typeof effort === "string" ? effort : undefined;
      })
      .filter((level): level is string => Boolean(level))
    : [];
  const efforts = [...new Set(levels)];
  const defaultEffort = typeof fallback === "string" ? fallback : undefined;
  return {
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

export function parseOpenCodeModels(raw: string, profile: Profile): ModelInfo[] {
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  return clean
    .split(/(?=^[^\s/]+\/[^\s/]+\s*$)/m)
    .map((chunk) => {
      const [id = "", ...metadataLines] = chunk.trim().split(/\r?\n/);
      if (!/^[^\s/]+\/[^\s/]+$/.test(id)) return undefined;
      const metadata = parseMetadata(metadataLines.join("\n"));
      return model(profile, id, id, "discovered", metadata);
    })
    .filter((item): item is ModelInfo => Boolean(item));
}

export function parseAntigravityModels(raw: string, profile: Profile): ModelInfo[] {
  return raw
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter((id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id))
    .map((id) => model(profile, id, id, "discovered"));
}

function parseMetadata(raw: string): Partial<ModelInfo> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as {
      cost?: { input?: unknown; output?: unknown };
      limit?: { context?: unknown };
      reasoning?: unknown;
      tool_call?: unknown;
      capabilities?: { reasoning?: unknown; toolcall?: unknown };
    };
    const input = number(value.cost?.input);
    const output = number(value.cost?.output);
    const contextWindow = number(value.limit?.context);
    return {
      ...(input !== undefined && output !== undefined ? { cost: { input, output } } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(typeof (value.capabilities?.reasoning ?? value.reasoning) === "boolean"
        ? { reasoning: (value.capabilities?.reasoning ?? value.reasoning) as boolean }
        : {}),
      ...(typeof (value.capabilities?.toolcall ?? value.tool_call) === "boolean"
        ? { toolCall: (value.capabilities?.toolcall ?? value.tool_call) as boolean }
        : {}),
    };
  } catch {
    return {};
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function model(
  profile: Profile,
  id: string,
  label: string,
  source: ModelInfo["source"],
  metadata: Partial<ModelInfo> = {},
): ModelInfo {
  return { id, label, provider: profile.provider, profileId: profile.id, source, ...metadata };
}
