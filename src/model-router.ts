import { loadConfig } from "./config";
import { listModels } from "./models";
import type { ModelInfo, Profile } from "./types";

export type RoutePreference = "balanced" | "quality" | "cost" | "speed";
export type TaskClass = "mechanical" | "context" | "build" | "reasoning" | "general";

export interface ModelTraits {
  quality: number;
  cost: number;
  speed: number;
  costSource: "catalog" | "heuristic";
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
}

export interface RouteOptions {
  preference?: RoutePreference;
  modelHint?: string;
}

export async function routeModel(prompt: string, options: RouteOptions = {}): Promise<ModelRoute> {
  const [models, config] = await Promise.all([listModels(), loadConfig()]);
  return chooseModel(prompt, models, config.profiles, options);
}

export function chooseModel(
  prompt: string,
  models: ModelInfo[],
  profiles: Profile[],
  options: RouteOptions = {},
): ModelRoute {
  const demand = classifyTask(prompt);
  const preference = options.preference ?? "balanced";
  const enabled = new Set(profiles.filter(({ enabled }) => enabled).map(({ id }) => id));
  const usable = models.filter((model) =>
    enabled.has(model.profileId) &&
    model.toolCall !== false &&
    !/(?:image|video|audio|embedding|tts)(?:[-/:]|$)/i.test(model.id)
  );
  const hinted = options.modelHint ? matchHint(usable, options.modelHint) : usable;
  if (hinted.length === 0) {
    throw new Error(options.modelHint
      ? `no available model matches: ${options.modelHint}`
      : "no routable models are available");
  }

  const candidates = hinted.map((model) => {
    const traits = modelTraits(model);
    return {
      profileId: model.profileId,
      model: model.id,
      score: score(traits, demand.requiredQuality, preference),
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
    requiredQuality: demand.requiredQuality,
    reason: `${demand.reason}; selected quality ${selected.traits.quality}/5, cost ${selected.traits.cost}/5, speed ${selected.traits.speed}/5`,
    candidates: candidates.slice(0, 3),
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
  const cost = /free/.test(id) ? 0
    : /(?:haiku|nano|mini|flash|spark|lite)/.test(id) ? 1
    : /(?:opus|fable|(?:^|[-/])sol|pro|max|ultra)/.test(id) ? 5
    : 3;
  return { quality, cost, speed, costSource: "heuristic" };
}

function score(traits: ModelTraits, requiredQuality: number, preference: RoutePreference): number {
  const qualityGap = traits.quality - requiredQuality;
  const fit = qualityGap < 0 ? 50 + qualityGap * 30 : 50 - qualityGap * 2;
  const weights = preference === "quality" ? { cost: 1, speed: 1, quality: 5 }
    : preference === "cost" ? { cost: 8, speed: 2, quality: 0 }
    : preference === "speed" ? { cost: 2, speed: 6, quality: 0 }
    : { cost: 4, speed: 2, quality: 0 };
  return fit - traits.cost * weights.cost + traits.speed * weights.speed + traits.quality * weights.quality;
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
