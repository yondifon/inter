import { loadConfig } from "./config";
import { listModels } from "./models";
import { normalizeProfileStatuses, type ProfileStatus } from "./profile-status";
import {
  allowMatches,
  allowRank,
  loadRoutingPolicy,
  modelAllowed,
  routeForTask,
  type RoutingPolicy,
} from "./routing-policy";
import { stateStore } from "./store";
import { listProfileUsage, worstWindowUsedPercent, type ProfileUsage } from "./usage";
import type {
  Difficulty,
  ModelInfo,
  Profile,
  RoutePreference,
  SelectionRejection,
  SelectionStage,
  TaskClass,
} from "./types";

export const DIFFICULTIES = ["mechanical", "standard", "hard", "critical"] as const satisfies
  readonly Difficulty[];
export const DEFAULT_DIFFICULTY: Difficulty = "standard";

/** Bumped whenever selection changes shape, so old records stay interpretable. */
export const ROUTER_VERSION = 2;

/// The capability tier each difficulty demands. Declaring too high buys one
/// over-priced success; declaring too low buys a cheap retry, so the default
/// sits low deliberately.
const DIFFICULTY_FLOOR: Record<Difficulty, number> = {
  mechanical: 2,
  standard: 3,
  hard: 4,
  critical: 5,
};

/// Where on a model's own effort ladder each difficulty lands, normalised so
/// ladders of different lengths stay comparable across providers.
const DIFFICULTY_EFFORT_TARGET: Record<Difficulty, number> = {
  mechanical: 0.1,
  standard: 0.3,
  hard: 0.6,
  critical: 0.9,
};

/// Inter's own effort vocabulary, weakest first. Claude's and pi's ladders are
/// built in this order; a provider that publishes its ladder in some other order
/// is re-sorted against this before anything is projected onto it.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/// At this much of a window spent the run dies part-way through, so it is a
/// filter rather than the score penalty that a cheap model can win through.
const NEAR_EXHAUSTED_PERCENT = 98;

/// Worth telling a caller that named the account itself, which no filter on the
/// automatic path will save from a window this far gone.
const LOW_HEADROOM_PERCENT = 90;

/// How many rejections ride a response and a task record. The catalogs run to
/// dozens of models per account, and a list of every model the policy does not
/// allow is noise in both places.
const MAX_REJECTED = 12;

const STAGE_ORDER: SelectionStage[] = [
  "floor",
  "quota",
  "availability",
  "catalog",
  "policy",
  "capability",
  "profile",
];

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
  difficulty: Difficulty;
  /// Lowest capability tier this task may run on: the difficulty's tier, or the
  /// project policy's, whichever is higher. Lowered only when nothing clears it.
  floor: number;
  floorRelaxed: boolean;
  /// False when the prompt heuristic wanted a stronger tier than the declared
  /// difficulty allows. Never overrides the declaration; it only records it.
  heuristicAgreed: boolean;
  effort?: string;
  effortReason: string;
  reason: string;
  candidates: ModelCandidate[];
  rejected: SelectionRejection[];
  rejectedCount: number;
  /** Worst usage window on the chosen account; null when its provider reports none. */
  quotaUsedPercent: number | null;
  warnings: string[];
}

export interface RoutePreferences {
  preference?: RoutePreference;
  modelHint?: string;
  difficulty?: Difficulty;
  /// Restrict routing to one profile the caller already named, leaving only the
  /// model to choose. Within a named profile the policy allow order wins, since
  /// the caller picked the account and wants its best model for this class.
  profileId?: string;
}

/**
 * Every candidate was filtered out. Carries the per-candidate reasons and the
 * earliest time any of them comes back, because a caller that knows an account
 * frees up in forty minutes can wait instead of guessing at another one.
 */
export class NoEligibleModelError extends Error {
  readonly code = "no_eligible_model";
  constructor(
    message: string,
    readonly rejected: SelectionRejection[],
    readonly earliestRetryAt?: string,
  ) {
    super(message);
    this.name = "NoEligibleModelError";
  }
}

export interface RouteOptions extends RoutePreferences {
  /// The target directory the work runs in. Required so the project policy is
  /// read from the workspace under discussion and never from the broker's own
  /// location, which reflects wherever the app happened to be launched.
  cwd: string;
}

export async function routeModel(prompt: string, options: RouteOptions): Promise<ModelRoute> {
  const inputs = await routingInputs(options.cwd);
  return chooseModel(
    prompt,
    inputs.models,
    inputs.profiles,
    options,
    inputs.statuses,
    inputs.policy,
    inputs.usage,
  );
}

interface RoutingInputs {
  models: ModelInfo[];
  profiles: Profile[];
  statuses: ProfileStatus[];
  policy?: RoutingPolicy;
  usage: ProfileUsage[];
}

/// Everything selection reads about the world, gathered once. The policy and
/// the profile set come from the task's cwd, so it is the workspace's own
/// files that decide, never the directory the broker happened to be launched
/// from.
async function routingInputs(cwd: string): Promise<RoutingInputs> {
  const [models, config, policy, usage] = await Promise.all([
    listModels({ cwd }),
    loadConfig(cwd),
    loadRoutingPolicy(cwd),
    listProfileUsage({ cwd }).catch(() => [] as ProfileUsage[]),
  ]);
  const store = stateStore();
  const statuses = normalizeProfileStatuses(
    config.profiles,
    models,
    store.listProfileFailures(),
    store.listProfileSuccesses(),
  );
  return { models, profiles: config.profiles, statuses, policy, usage };
}

export function chooseModel(
  prompt: string,
  models: ModelInfo[],
  profiles: Profile[],
  options: RoutePreferences = {},
  statuses: ProfileStatus[] = [],
  policy?: RoutingPolicy,
  usage: ProfileUsage[] = [],
): ModelRoute {
  const demand = classifyTask(prompt);
  const difficulty = options.difficulty ?? DEFAULT_DIFFICULTY;
  const policyRoute = policy ? routeForTask(policy, demand.taskClass) : undefined;
  const preference = options.preference ?? policyRoute?.preference ?? "balanced";
  const declaredFloor = DIFFICULTY_FLOOR[difficulty];
  const floor = Math.max(declaredFloor, policyRoute?.minQuality ?? 0);
  const heuristicAgreed = demand.requiredQuality <= declaredFloor;
  const warnings: string[] = [];
  const rejected: SelectionRejection[] = [];
  const reject = (model: ModelInfo, stage: SelectionStage, reason: string, retryAt?: string) => {
    rejected.push({
      profileId: model.profileId,
      model: model.id,
      stage,
      reason,
      ...(retryAt ? { retryAt } : {}),
    });
    return false;
  };

  const enabled = new Set(profiles.filter(({ enabled }) => enabled).map(({ id }) => id));
  const catalog = models.filter((model) => enabled.has(model.profileId));
  const base = models.filter((model) => {
    if (options.profileId !== undefined && model.profileId !== options.profileId) return false;
    if (!enabled.has(model.profileId)) return reject(model, "profile", "account is disabled");
    if (model.toolCall === false) return reject(model, "capability", "model cannot call tools");
    if (/(?:image|video|audio|embedding|tts)(?:[-/:]|$)/i.test(model.id)) {
      return reject(model, "capability", "not a text model");
    }
    return true;
  });
  if (options.profileId && base.length === 0) {
    throw new Error(`profile ${options.profileId} has no routable model`);
  }
  const requested = options.modelHint ? matchHint(base, options.modelHint) : base;
  if (options.modelHint && requested.length === 0) {
    throw new Error(`no model matches hint: ${options.modelHint}`);
  }

  // The allow list is the authority on what may run, so a rule naming a model no
  // account actually offers is a config problem the user has to see: it silently
  // shrinks the choice for this whole class of work. Reported after the per-model
  // findings, which are the ones that explain this dispatch.
  const configWarnings = policyRoute
    ? policyRoute.allow
      .filter((rule) => !catalog.some((model) => allowMatches(rule, model.provider, model.id)))
      .map((rule) =>
        `project policy allows ${rule.provider} model ${rule.model} for ${demand.taskClass} work, ` +
        `but no connected account offers it; remove the entry or connect that account`
      )
    : [];

  let policyExcluded = 0;
  const policyEligible = policyRoute
    ? requested.filter((model) => {
      if (modelAllowed(policyRoute, model.provider, model.id)) return true;
      policyExcluded++;
      return reject(model, "policy", `not allowed for ${demand.taskClass} work by project policy`);
    })
    : requested;
  if (policyExcluded > 0) {
    warnings.push(
      `excluded ${policyExcluded} models: not allowed by project policy route ${demand.taskClass}`,
    );
  }

  const statusByModel = new Map(statuses.map((status) => [
    statusKey(status.profile, status.model),
    status,
  ]));
  const available = policyEligible.filter((model) => {
    const status = statusByModel.get(statusKey(model.profileId, model.id));
    if (!status) return true;
    if (status.state === "unavailable") {
      warnings.push(`excluded model ${model.profileId}/${model.id}: ${status.reason}${
        status.retryAt ? `; retry at ${status.retryAt}` : ""
      }`);
      return reject(model, "availability", status.reason, status.retryAt);
    }
    if (status.state === "unknown") {
      warnings.push(
        `availability unknown for ${model.profileId}/${model.id}: ${status.reason}`,
      );
    }
    return true;
  });

  // A provider that reports no usage at all — opencode and pi report none — is
  // unknown headroom, so it is neither filtered nor penalised. Reading a silent
  // provider as spent would exclude the accounts that carry most of the work;
  // reading it as free would make silence the cheapest thing to buy. Headroom is
  // read per model, because a provider that meters one model family separately
  // reports a window that governs that family and no other.
  const usageByProfile = new Map(usage.map((row) => [row.profile, row]));
  const usedByCandidate = new Map<string, number>();
  for (const model of available) {
    const row = usageByProfile.get(model.profileId);
    const used = row ? worstWindowUsedPercent(row, model.id) : undefined;
    if (used !== undefined) usedByCandidate.set(statusKey(model.profileId, model.id), used);
  }
  const usedBy = (model: ModelInfo): number | undefined =>
    usedByCandidate.get(statusKey(model.profileId, model.id));
  const isExhausted = (model: ModelInfo): boolean =>
    (usedBy(model) ?? 0) >= NEAR_EXHAUSTED_PERCENT;
  for (const [profileId, spent] of groupByProfile(available.filter(isExhausted), usedBy)) {
    warnings.push(
      `${profileId} has ${100 - Math.min(...spent.map(({ used }) => used))}% left on the window covering ` +
      `${spent.map(({ id }) => id).join(", ")}, too little to finish a task`,
    );
  }
  // Only automatic routing may lose a candidate to quota. A caller that named
  // the account gets the warning and keeps the dispatch.
  const usable = options.profileId === undefined
    ? available.filter((model) => {
      if (!isExhausted(model)) return true;
      return reject(model, "quota", `${usedBy(model)}% of the usage window is spent`);
    })
    : available;
  const strained = usable.filter((model) => {
    const used = usedBy(model);
    return used !== undefined && used >= 75 && used < NEAR_EXHAUSTED_PERCENT;
  });
  for (const [profileId, spent] of groupByProfile(strained, usedBy)) {
    warnings.push(
      `${profileId} is ${Math.max(...spent.map(({ used }) => used))}% into the rate-limit window covering ` +
      `${spent.map(({ id }) => id).join(", ")}; deprioritized`,
    );
  }

  if (usable.length === 0) {
    throw noEligibleModel(
      options.modelHint,
      demand.taskClass,
      [...warnings, ...configWarnings],
      rejected,
    );
  }

  const traitsByModel = new Map(usable.map((model) => [
    statusKey(model.profileId, model.id),
    modelTraits(model),
  ]));
  const traitsOf = (model: ModelInfo): ModelTraits =>
    traitsByModel.get(statusKey(model.profileId, model.id))!;

  // The floor is what difficulty buys: a tier the work is known to need. It
  // gives way only when nothing clears it, since a run below the intended tier
  // beats no run and the record says which happened.
  let effectiveFloor = floor;
  let clearing = usable.filter((model) => traitsOf(model).quality >= effectiveFloor);
  while (clearing.length === 0 && effectiveFloor > 1) {
    effectiveFloor--;
    clearing = usable.filter((model) => traitsOf(model).quality >= effectiveFloor);
  }
  const floorRelaxed = effectiveFloor < floor;
  if (floorRelaxed) {
    warnings.push(
      `no connected account offers a model strong enough for ${difficulty} work; ` +
      `ran the strongest one available`,
    );
  }
  for (const model of usable) {
    const { quality } = traitsOf(model);
    if (quality < effectiveFloor) {
      reject(model, "floor", `tier ${quality} of 5 is below what ${difficulty} work needs`);
    }
  }

  // Rank only bites when the caller named the profile. Left flat otherwise, so
  // automatic routing stays score-driven and the rate-limit penalty still wins.
  const rankByModel = new Map(clearing.map((model) => [
    statusKey(model.profileId, model.id),
    options.profileId && policyRoute ? allowRank(policyRoute, model.provider, model.id) : 0,
  ]));
  const rankOf = ({ profileId, model }: ModelCandidate): number =>
    rankByModel.get(statusKey(profileId, model)) ?? 0;

  const candidates = clearing.map((model) => {
    const traits = traitsOf(model);
    return {
      profileId: model.profileId,
      model: model.id,
      score: score(traits, effectiveFloor, preference) - usagePenalty(usedBy(model)),
      traits,
    };
  }).sort((a, b) =>
    rankOf(a) - rankOf(b) ||
    b.score - a.score ||
    a.profileId.localeCompare(b.profileId) ||
    a.model.localeCompare(b.model)
  );
  const selected = candidates[0]!;
  const chosen = clearing.find((model) =>
    model.profileId === selected.profileId && model.id === selected.model
  )!;
  const effort = projectEffort(chosen, difficulty);
  const used = usedByCandidate.get(statusKey(selected.profileId, selected.model));
  return {
    profileId: selected.profileId,
    model: selected.model,
    preference,
    taskClass: demand.taskClass,
    difficulty,
    floor: effectiveFloor,
    floorRelaxed,
    heuristicAgreed,
    ...(effort.effort ? { effort: effort.effort } : {}),
    effortReason: effort.reason,
    reason: `${demand.reason}${
      policyRoute ? `; applied project policy route ${demand.taskClass}` : ""
    }; selected quality ${selected.traits.quality}/5, cost ${selected.traits.cost}/5, speed ${selected.traits.speed}/5`,
    candidates: diverseCandidates(candidates, 3),
    rejected: topRejections(rejected),
    rejectedCount: rejected.length,
    quotaUsedPercent: used ?? null,
    warnings: [
      ...warnings,
      ...(options.difficulty !== undefined && !heuristicAgreed
        ? [heuristicNote(demand.reason, difficulty)]
        : []),
      ...configWarnings,
      ...candidates
        .filter(({ traits }) => traits.costSource === "unknown")
        .slice(0, 1)
        .map(() => "some candidates have unknown price data; cost was scored neutrally"),
    ],
  };
}

/**
 * What the caller-named path reports without ever blocking it. The same filters
 * automatic routing applies, run as advice: naming a profile and a model is the
 * caller's call, but sending work to an account with revoked credentials should
 * not be silent about it.
 */
export interface NamedRouteAudit {
  taskClass: TaskClass;
  preference: RoutePreference;
  difficulty: Difficulty;
  floor: number;
  heuristicAgreed: boolean;
  effort?: string;
  effortReason: string;
  quotaUsedPercent: number | null;
  rejected: SelectionRejection[];
  warnings: string[];
}

export async function auditNamedRoute(
  prompt: string,
  options: { cwd: string; profileId: string; model: string; difficulty?: Difficulty; effort?: string },
): Promise<NamedRouteAudit> {
  // One account's catalog and quota, not every account's: this runs on the path
  // where the caller already knows where the work goes, and a dispatch should not
  // wait on providers it is not using. Both queries reject on an unknown or
  // disabled profile, which is `delegate`'s error to report, not the audit's — so
  // the audit reports what it can see and lets the dispatch produce it.
  const query = { profile: options.profileId, cwd: options.cwd };
  const [models, config, policy, usage] = await Promise.all([
    listModels(query).catch(() => [] as ModelInfo[]),
    loadConfig(options.cwd),
    loadRoutingPolicy(options.cwd),
    listProfileUsage(query).catch(() => [] as ProfileUsage[]),
  ]);
  const store = stateStore();
  const statuses = normalizeProfileStatuses(
    config.profiles,
    models,
    store.listProfileFailures(),
    store.listProfileSuccesses(),
  );
  return checkNamedRoute(prompt, options, models, config.profiles, statuses, policy, usage);
}

export function checkNamedRoute(
  prompt: string,
  options: { profileId: string; model: string; difficulty?: Difficulty; effort?: string; preference?: RoutePreference },
  models: ModelInfo[],
  profiles: Profile[],
  statuses: ProfileStatus[] = [],
  policy?: RoutingPolicy,
  usage: ProfileUsage[] = [],
): NamedRouteAudit {
  const { profileId, model: modelId } = options;
  const demand = classifyTask(prompt);
  const difficulty = options.difficulty ?? DEFAULT_DIFFICULTY;
  const policyRoute = policy ? routeForTask(policy, demand.taskClass) : undefined;
  const declaredFloor = DIFFICULTY_FLOOR[difficulty];
  const heuristicAgreed = demand.requiredQuality <= declaredFloor;
  const warnings: string[] = [];
  const rejected: SelectionRejection[] = [];
  const add = (stage: SelectionStage, reason: string, retryAt?: string) => {
    rejected.push({ profileId, model: modelId, stage, reason, ...(retryAt ? { retryAt } : {}) });
  };

  const provider = profiles.find(({ id }) => id === profileId)?.provider;
  const offered = models.filter((model) => model.profileId === profileId);
  const chosen = offered.find((model) => model.id === modelId);
  // Discovery that fails falls back to the one model the profile is configured
  // with, and that list is not evidence about anything else the account offers.
  // Only a list that was actually enumerated can say a model is missing from it.
  const enumerated = offered.length > 1 || offered.some(({ source }) => source === "discovered");
  if (!chosen && enumerated) {
    add("catalog", "the account does not list this model");
    warnings.push(
      `${profileId} does not list a model called ${modelId}. Check what it offers before dispatching, ` +
      `or the run may fail at start.`,
    );
  }

  const status = statuses.find((item) => item.profile === profileId && item.model === modelId);
  if (status?.state === "unavailable") {
    add("availability", status.reason, status.retryAt);
    warnings.push(
      `${profileId} is unavailable. ${status.reason}${
        status.retryAt ? `; it should answer again after ${status.retryAt}` : ""
      }. Dispatching anyway.`,
    );
  }

  const measured = usage.find(({ profile }) => profile === profileId);
  const used = measured ? worstWindowUsedPercent(measured, modelId) : undefined;
  if (used !== undefined && used >= LOW_HEADROOM_PERCENT) {
    if (used >= NEAR_EXHAUSTED_PERCENT) add("quota", `${used}% of the usage window is spent`);
    warnings.push(
      `${profileId} has ${100 - used}% left on the window covering ${modelId}; ` +
      `the run may stop part-way through.`,
    );
  }

  if (policyRoute && provider && !modelAllowed(policyRoute, provider, modelId)) {
    add("policy", `not allowed for ${demand.taskClass} work by project policy`);
    warnings.push(
      `${provider} model ${modelId} is not one this project allows for ${demand.taskClass} work; ` +
      `the explicit choice overrode the project's routing policy.`,
    );
  }

  const effort = chosen
    ? projectEffort(chosen, difficulty)
    : { reason: "the account's model list does not cover this model, so its effort levels are unknown" };
  if (options.effort && chosen?.efforts && !chosen.efforts.includes(options.effort)) {
    warnings.push(
      `${modelId} accepts ${chosen.efforts.join(", ")} as reasoning levels, not ${options.effort}; ` +
      `passing it through as asked.`,
    );
  }
  if (options.difficulty !== undefined && !heuristicAgreed) {
    warnings.push(heuristicNote(demand.reason, difficulty));
  }

  return {
    taskClass: demand.taskClass,
    preference: options.preference ?? policyRoute?.preference ?? "balanced",
    difficulty,
    floor: Math.max(declaredFloor, policyRoute?.minQuality ?? 0),
    heuristicAgreed,
    ...(effort.effort ? { effort: effort.effort } : {}),
    effortReason: effort.reason,
    quotaUsedPercent: used ?? null,
    rejected: topRejections(rejected),
    warnings,
  };
}

/**
 * The rung of this model's own ladder that the difficulty asks for. Only ever a
 * value the provider published, so a projected effort cannot be one the CLI
 * rejects; a provider with no ladder gets no effort flag rather than an invented
 * rung.
 */
export function projectEffort(
  model: ModelInfo,
  difficulty: Difficulty,
): { effort?: string; reason: string } {
  const published = model.efforts ?? [];
  if (published.length === 0) {
    return { reason: `${model.provider} publishes no reasoning levels for this model` };
  }
  const known = published.every((level) => EFFORT_ORDER.includes(level));
  // Claude's and pi's ladders are ours and already weakest-first; codex sends
  // its own and the order it uses is not part of its contract. Sorting by
  // Inter's vocabulary makes the projection independent of that order, and a
  // ladder using words outside the vocabulary keeps the published order.
  const ladder = known
    ? [...published].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    : published;
  const rung = ladder[Math.round(DIFFICULTY_EFFORT_TARGET[difficulty] * (ladder.length - 1))]!;
  return {
    effort: rung,
    reason: known
      ? `${difficulty} work sits at ${rung} on this model's ${ladder.length} levels`
      : `${difficulty} work sits at ${rung} in the order ${model.provider} published`,
  };
}

export function difficultyFloor(difficulty: Difficulty): number {
  return DIFFICULTY_FLOOR[difficulty];
}

/// The declaration is never overridden, so the disagreement is said out loud
/// instead: the caller sees its own optimism, and so does whoever reads the task.
/// Only a declaration earns this. `heuristicAgreed` is recorded either way, but
/// warning about the default on every prompt containing "implement" is noise.
function heuristicNote(heuristicReason: string, difficulty: Difficulty): string {
  return `this reads like ${heuristicReason} but was sent as ${difficulty} work; ` +
    `raise difficulty if the result comes back thin`;
}

function noEligibleModel(
  modelHint: string | undefined,
  taskClass: TaskClass,
  warnings: string[],
  rejected: SelectionRejection[],
): NoEligibleModelError {
  const retryTimes = rejected
    .map(({ retryAt }) => retryAt)
    .filter((retryAt): retryAt is string => Boolean(retryAt))
    .sort();
  const earliestRetryAt = retryTimes[0];
  const detail = warnings.length ? `; ${warnings.join("; ")}` : "";
  const wait = earliestRetryAt ? `; the earliest is available again at ${earliestRetryAt}` : "";
  return new NoEligibleModelError(
    (modelHint
      ? `model hint ${modelHint} has no eligible model for ${taskClass}${detail}`
      : `no routable models are available${detail}`) + wait,
    topRejections(rejected),
    earliestRetryAt,
  );
}

/// Most-informative first, then capped: a candidate dropped at the floor says
/// more about the decision than the dozens a provider's catalog contributes
/// which the policy was never going to allow.
function topRejections(rejected: SelectionRejection[]): SelectionRejection[] {
  return [...rejected]
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
    .slice(0, MAX_REJECTED);
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
  // `flash` in a model name almost always marks a small tier, but
  // deepseek-v4-flash is a full-strength everyday model. The name test below
  // runs first and would floor it at 2, which is under the min_quality of
  // every route class — so policy could never select it, however it is listed.
  const quality = /deepseek-v4-flash/.test(id) ? 4
    : /(?:haiku|nano|mini|flash|spark|lite|20b)/.test(id) ? 2
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

/// Quota findings read per model but are said per account: a claude profile
/// whose session window covers four models would otherwise repeat one number
/// four times.
function groupByProfile(
  models: ModelInfo[],
  usedBy: (model: ModelInfo) => number | undefined,
): Map<string, Array<{ id: string; used: number }>> {
  const groups = new Map<string, Array<{ id: string; used: number }>>();
  for (const model of models) {
    const used = usedBy(model);
    if (used === undefined) continue;
    const group = groups.get(model.profileId) ?? [];
    group.push({ id: model.id, used });
    groups.set(model.profileId, group);
  }
  return groups;
}
