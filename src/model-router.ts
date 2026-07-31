import { loadConfig } from "./config";
import { listModels } from "./models";
import { normalizeProfileStatuses, type ProfileStatus } from "./profile-status";
import {
  loadRoutingPolicy,
  modelAllowed,
  routeForTask,
  type RoutingPolicy,
} from "./routing-policy";
import { stateStore } from "./store";
import { listProfileUsage, worstWindowUsedPercent, type ProfileUsage } from "./usage";
import type { ModelInfo, Profile } from "./types";

export type RoutePreference = "balanced" | "quality" | "cost" | "speed";
export type TaskClass = "mechanical" | "context" | "build" | "reasoning" | "general";

export interface ModelTraits {
  quality: number;
  cost: number;
  speed: number;
  costSource: "catalog" | "heuristic" | "unknown";
  estimatedInputUsdPerMillion?: number;
  estimatedOutputUsdPerMillion?: number;
}

export interface ModelCandidate {
  profileId: string;
  model: string;
  score: number;
  traits: ModelTraits;
}

export interface ModelRoute {
  profileId: string;
  model: string;
  preference: RoutePreference;
  taskClass: TaskClass;
  requiredQuality: number;
  reason: string;
  candidates: ModelCandidate[];
  warnings: string[];
}

export interface RouteOptions {
  preference?: RoutePreference;
  modelHint?: string;
  cwd?: string;
}

export async function routeModel(prompt: string, options: RouteOptions = {}): Promise<ModelRoute> {
  const [models, config, policy, usage] = await Promise.all([
    listModels(),
    loadConfig(),
    options.cwd === undefined ? Promise.resolve(undefined) : loadRoutingPolicy(options.cwd),
    listProfileUsage().catch(() => [] as ProfileUsage[]),
  ]);
  const store = stateStore();
  const statuses = normalizeProfileStatuses(
    config.profiles,
    models,
    store.listProfileFailures(),
    store.listProfileSuccesses(),
  );
  return chooseModel(prompt, models, config.profiles, options, statuses, policy, usage);
}

export function chooseModel(
  prompt: string,
  models: ModelInfo[],
  profiles: Profile[],
  options: RouteOptions = {},
  statuses: ProfileStatus[] = [],
  policy?: RoutingPolicy,
  usage: ProfileUsage[] = [],
): ModelRoute {
  const demand = classifyTask(prompt);
  const policyRoute = policy ? routeForTask(policy, demand.taskClass) : undefined;
  const preference = options.preference ?? policyRoute?.preference ?? "balanced";
  const requiredQuality = Math.max(demand.requiredQuality, policyRoute?.minQuality ?? 0);
  const enabled = new Set(profiles.filter(({ enabled }) => enabled).map(({ id }) => id));
  const base = models.filter((model) =>
    enabled.has(model.profileId) &&
    model.toolCall !== false &&
    !/(?:image|video|audio|embedding|tts)(?:[-/:]|$)/i.test(model.id)
  );
  const requested = options.modelHint ? matchHint(base, options.modelHint) : base;
  if (options.modelHint && requested.length === 0) {
    throw new Error(`no model matches hint: ${options.modelHint}`);
  }

  const warnings: string[] = [];
  const policyEligible = policyRoute
    ? requested.filter((model) => {
      const allowed = modelAllowed(policyRoute, model.provider, model.id);
      if (!allowed) {
        warnings.push(
          `excluded model ${model.profileId}/${model.id}: not allowed by project policy route ${demand.taskClass}`,
        );
      }
      return allowed;
    })
    : requested;

  const statusByModel = new Map(statuses.map((status) => [
    statusKey(status.profile, status.model),
    status,
  ]));
  const usable = policyEligible.filter((model) => {
    const status = statusByModel.get(statusKey(model.profileId, model.id));
    if (!status) return true;
    if (status.state === "unavailable") {
      warnings.push(`excluded model ${model.profileId}/${model.id}: ${status.reason}${
        status.retryAt ? `; retry at ${status.retryAt}` : ""
      }`);
      return false;
    }
    if (status.state === "unknown") {
      warnings.push(
        `availability unknown for ${model.profileId}/${model.id}: ${status.reason}`,
      );
    }
    return true;
  });

  if (usable.length === 0) {
    const detail = warnings.length ? `; ${warnings.join("; ")}` : "";
    throw new Error(options.modelHint
      ? `model hint ${options.modelHint} has no eligible model for ${demand.taskClass}${detail}`
      : `no routable models are available${detail}`);
  }

  // A profile deep into a rate-limit window would die mid-task; push work
  // toward profiles with headroom instead of hard-excluding possibly stale data.
  const usedByProfile = new Map<string, number>();
  for (const row of usage) {
    const worst = worstWindowUsedPercent(row);
    if (worst !== undefined) usedByProfile.set(row.profile, worst);
  }
  for (const [profileId, used] of usedByProfile) {
    if (used >= 75 && usable.some((model) => model.profileId === profileId)) {
      warnings.push(`profile ${profileId} is ${used}% into a rate-limit window; deprioritized`);
    }
  }

  const candidates = usable.map((model) => {
    const traits = modelTraits(model);
    return {
      profileId: model.profileId,
      model: model.id,
      score: score(traits, requiredQuality, preference) - usagePenalty(usedByProfile.get(model.profileId)),
      traits,
    };
  }).sort((a, b) =>
    b.score - a.score ||
    a.profileId.localeCompare(b.profileId) ||
    a.model.localeCompare(b.model)
  );
  const selected = candidates[0]!;
  return {
    profileId: selected.profileId,
    model: selected.model,
    preference,
    taskClass: demand.taskClass,
    requiredQuality,
    reason: `${demand.reason}${
      policyRoute ? `; applied project policy route ${demand.taskClass}` : ""
    }; selected quality ${selected.traits.quality}/5, cost ${selected.traits.cost}/5, speed ${selected.traits.speed}/5`,
    candidates: diverseCandidates(candidates, 3),
    warnings: [
      ...warnings,
      ...candidates
        .filter(({ traits }) => traits.costSource === "unknown")
        .slice(0, 1)
        .map(() => "some candidates have unknown price data; cost was scored neutrally"),
    ],
  };
}

export function classifyTask(prompt: string): {
  taskClass: TaskClass;
  requiredQuality: number;
  reason: string;
} {
  const text = prompt.toLowerCase();
  if (/(?:architect|architecture|security|threat|migration|concurren|race condition|root cause|trade-?off|system design|hard research)/.test(text)) {
    return { taskClass: "reasoning", requiredQuality: 5, reason: "deep judgment or failure analysis" };
  }
  if (/(?:understand|trace|investigate|review|audit|analy[sz]e|read.*(?:codebase|files)|how .* works|why .* fail)/s.test(text)) {
    return { taskClass: "context", requiredQuality: 4, reason: "cross-file context comprehension" };
  }
  if (/(?:implement|build|fix|debug|refactor|write .*test|add .*feature)/.test(text)) {
    return { taskClass: "build", requiredQuality: 4, reason: "implementation needs sound code judgment" };
  }
  if (/(?:rename|format|lint|find and replace|mechanical|generate|commit message|summari[sz]e this|list files)/.test(text)) {
    return { taskClass: "mechanical", requiredQuality: 2, reason: "bounded mechanical work" };
  }
  return { taskClass: "general", requiredQuality: 3, reason: "general bounded work" };
}

export function modelTraits(model: ModelInfo): ModelTraits {
  const id = model.id.toLowerCase();
  const quality = /(?:haiku|nano|mini|flash|spark|lite|20b)/.test(id) ? 2
    : /(?:opus|fable|(?:^|[-/])sol|pro|max|ultra|reasoning|kimi-k3|kimi-k2\.7-code|gpt-5\.6)/.test(id) ? 5
    : /(?:sonnet|luna|terra|kimi-k2\.[56]|large|gpt-5\.[45]|glm-5|qwen3\.[67]|minimax-m3)/.test(id) ? 4
    : 3;
  const speed = /(?:fast|flash|spark|haiku|nano|lite)/.test(id) ? 5
    : /mini/.test(id) ? 4
    : /(?:opus|(?:^|[-/])sol|max|ultra|reasoning)/.test(id) ? 1
    : 3;
  if (model.cost) {
    const blended = model.cost.input * 0.8 + model.cost.output * 0.2;
    const cost = blended === 0 ? 0 : blended <= 0.5 ? 1 : blended <= 2 ? 2
      : blended <= 8 ? 3 : blended <= 20 ? 4 : 5;
    return {
      quality,
      cost,
      speed,
      costSource: "catalog",
      estimatedInputUsdPerMillion: model.cost.input,
      estimatedOutputUsdPerMillion: model.cost.output,
    };
  }
  if (/(?:free|haiku|nano|mini|flash|spark|lite|opus|fable|(?:^|[-/])sol|pro|max|ultra)/.test(id)) {
    const cost = /free/.test(id) ? 0 : /(?:haiku|nano|mini|flash|spark|lite)/.test(id) ? 1 : 5;
    return { quality, cost, speed, costSource: "heuristic" };
  }
  return { quality, cost: 2, speed, costSource: "unknown" };
}

function usagePenalty(usedPercent: number | undefined): number {
  if (usedPercent === undefined) return 0;
  return usedPercent >= 95 ? 60 : usedPercent >= 90 ? 40 : usedPercent >= 75 ? 15 : 0;
}

function score(traits: ModelTraits, requiredQuality: number, preference: RoutePreference): number {
  const qualityGap = traits.quality - requiredQuality;
  const fit = qualityGap < 0 ? 50 + qualityGap * 30 : 50;
  const weights = preference === "quality" ? { cost: 1, speed: 1, quality: 5 }
    : preference === "cost" ? { cost: 8, speed: 2, quality: 0 }
    : preference === "speed" ? { cost: 2, speed: 6, quality: 0 }
    : { cost: 4, speed: 2, quality: 0 };
  return fit - traits.cost * weights.cost + traits.speed * weights.speed + traits.quality * weights.quality;
}

function diverseCandidates(candidates: ModelCandidate[], limit: number): ModelCandidate[] {
  const selected: ModelCandidate[] = [];
  const profiles = new Set<string>();
  for (const candidate of candidates) {
    if (profiles.has(candidate.profileId)) continue;
    selected.push(candidate);
    profiles.add(candidate.profileId);
    if (selected.length === limit) return selected;
  }
  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

function matchHint(models: ModelInfo[], hint: string): ModelInfo[] {
  const exact = models.filter(({ id }) => id === hint);
  if (exact.length > 0) return exact;
  const wanted = canonical(hint);
  const byName = models.filter(({ id }) => canonical(id.split("/").at(-1) ?? id) === wanted);
  if (byName.length > 0) return byName;
  return models.filter(({ id }) => canonical(id).includes(wanted));
}

function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^kimik(?=\d)/, "kimi");
}

function statusKey(profileId: string, modelId: string): string {
  return `${profileId}\0${modelId}`;
}
