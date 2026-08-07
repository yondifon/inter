import { loadTomlLayers, TomlConfigError, type TomlLayer, type TomlLayers } from "./inter-toml";
import type { RoutePreference, TaskClass } from "./types";

const TASK_CLASSES: TaskClass[] = ["mechanical", "context", "build", "reasoning", "general"];
const PREFERENCES: RoutePreference[] = ["balanced", "quality", "cost", "speed"];

export interface AllowedModel {
  provider: string;
  model: string;
}

export interface RoutingPolicyRoute {
  preference?: RoutePreference;
  minQuality?: number;
  allow: AllowedModel[];
}

export interface RoutingPolicy {
  version: 1;
  /** The highest file that contributed a route. */
  path: string;
  /** Every file that contributed a route, highest first. */
  sources?: string[];
  routes: Partial<Record<TaskClass, RoutingPolicyRoute>>;
}

export class RoutingPolicyError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    message: string,
  ) {
    super(`invalid routing policy ${path} at ${field}: ${message}`);
    this.name = "RoutingPolicyError";
  }
}

/**
 * The effective policy for a cwd: the project file's routes merged over the
 * user file's, which in turn stands where the project says nothing. Per class,
 * scalar fields override and `allow` replaces whole — an allow list is written
 * best-first, so merging two lists would scramble its meaning.
 */
export async function loadRoutingPolicy(cwd: string): Promise<RoutingPolicy | undefined> {
  let layers: TomlLayers;
  try {
    layers = await loadTomlLayers(cwd);
  } catch (error) {
    throw policyLayerError(error);
  }
  const project = layers.project ? validatePolicy(layers.project.root, layers.project.path) : undefined;
  const user = layers.user ? validatePolicy(layers.user.root, layers.user.path) : undefined;
  return mergePolicies(project, user);
}

function policyLayerError(error: unknown): unknown {
  if (error instanceof TomlConfigError) {
    return new RoutingPolicyError(error.path, error.field, error.message);
  }
  return error;
}

function mergePolicies(
  project: RoutingPolicy | undefined,
  user: RoutingPolicy | undefined,
): RoutingPolicy | undefined {
  if (!project && !user) return undefined;
  const classes = new Set<TaskClass>([
    ...Object.keys(project?.routes ?? {}),
    ...Object.keys(user?.routes ?? {}),
  ] as TaskClass[]);
  const routes: RoutingPolicy["routes"] = {};
  for (const taskClass of classes) {
    const p = project?.routes[taskClass];
    const u = user?.routes[taskClass];
    routes[taskClass] = {
      preference: p?.preference ?? u?.preference,
      minQuality: p?.minQuality ?? u?.minQuality,
      allow: (p ?? u)!.allow,
    };
  }
  const sources = [project?.path, user?.path].filter((path): path is string => Boolean(path));
  return { version: 1, path: sources[0]!, sources, routes };
}

export function routeForTask(
  policy: RoutingPolicy,
  taskClass: TaskClass | string,
): RoutingPolicyRoute | undefined {
  const normalized = normalizeTaskClass(taskClass);
  return normalized ? policy.routes[normalized] : undefined;
}

export function modelAllowed(
  route: RoutingPolicyRoute,
  providerId: string,
  modelId: string,
): boolean {
  return Number.isFinite(allowRank(route, providerId, modelId));
}

/// Whether one allow rule covers this model. Needed per rule, not per route:
/// a rule matching nothing any account offers is a config mistake worth naming,
/// and `allowRank` reports only the first rule that matched.
export function allowMatches(
  rule: AllowedModel,
  providerId: string,
  modelId: string,
): boolean {
  return rule.provider === normalizeId(providerId) &&
    globMatches(rule.model, normalizeId(modelId));
}

/// Position of the first allow rule matching this model. Entries are written
/// best-first, so this is the preference order to use when a caller has already
/// named the profile and only the model is left to choose.
export function allowRank(
  route: RoutingPolicyRoute,
  providerId: string,
  modelId: string,
): number {
  const index = route.allow.findIndex((rule) => allowMatches(rule, providerId, modelId));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

export function normalizeTaskClass(value: string): TaskClass | undefined {
  const normalized = value.trim().toLowerCase();
  return TASK_CLASSES.find((taskClass) => taskClass === normalized);
}

function validatePolicy(raw: unknown, path: string): RoutingPolicy | undefined {
  const root = expectRecord(raw, path, "root");
  rejectUnknownFields(root, ["version", "routes", "worker", "profiles"], path, "root");
  // `[worker]` alone is a complete file: prompt rules are read by
  // loadWorkerRules, and a project with no `[routes]` has no routing policy to
  // version or validate.
  if (root.routes === undefined) return undefined;
  if (root.version !== 1) {
    fail(path, "version", "must be 1");
  }
  const rawRoutes = expectRecord(root.routes, path, "routes");
  const routes: RoutingPolicy["routes"] = {};
  for (const [routeKey, value] of Object.entries(rawRoutes)) {
    const taskClass = normalizeTaskClass(routeKey);
    if (!taskClass) {
      fail(path, `routes.${routeKey}`, `unsupported task class; expected ${TASK_CLASSES.join(", ")}`);
    }
    if (Object.hasOwn(routes, taskClass)) {
      fail(path, `routes.${routeKey}`, `duplicates normalized task class ${taskClass}`);
    }
    routes[taskClass] = validateRoute(value, path, `routes.${routeKey}`);
  }
  if (Object.keys(routes).length === 0) {
    fail(path, "routes", "must define at least one task class");
  }
  return { version: 1, path, routes };
}

function validateRoute(raw: unknown, path: string, field: string): RoutingPolicyRoute {
  const route = expectRecord(raw, path, field);
  rejectUnknownFields(route, ["preference", "min_quality", "allow"], path, field);

  let preference: RoutePreference | undefined;
  if (route.preference !== undefined) {
    if (typeof route.preference !== "string" || !PREFERENCES.includes(route.preference as RoutePreference)) {
      fail(path, `${field}.preference`, `must be one of ${PREFERENCES.join(", ")}`);
    }
    preference = route.preference as RoutePreference;
  }

  let minQuality: number | undefined;
  if (route.min_quality !== undefined) {
    if (!Number.isInteger(route.min_quality) || (route.min_quality as number) < 1 || (route.min_quality as number) > 5) {
      fail(path, `${field}.min_quality`, "must be an integer from 1 to 5");
    }
    minQuality = route.min_quality as number;
  }

  if (!Array.isArray(route.allow) || route.allow.length === 0) {
    fail(path, `${field}.allow`, "must be a non-empty array");
  }
  const allow = route.allow.map((rule, index) =>
    validateAllowedModel(rule, path, `${field}.allow[${index}]`)
  );
  return { preference, minQuality, allow };
}

function validateAllowedModel(raw: unknown, path: string, field: string): AllowedModel {
  const rule = expectRecord(raw, path, field);
  rejectUnknownFields(rule, ["provider", "model"], path, field);
  if (typeof rule.provider !== "string" || !/^[a-z0-9._-]+$/i.test(rule.provider)) {
    fail(path, `${field}.provider`, "must be a provider ID without globs");
  }
  if (typeof rule.model !== "string" || !/^[a-z0-9._:/@*-]+$/i.test(rule.model)) {
    fail(path, `${field}.model`, "must be a model ID glob using only safe ID characters and *");
  }
  return {
    provider: normalizeId(rule.provider),
    model: normalizeId(rule.model),
  };
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function expectRecord(value: unknown, path: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, field, "must be a table");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(path, field === "root" ? unknown : `${field}.${unknown}`, "unknown field");
}

function fail(path: string, field: string, message: string): never {
  throw new RoutingPolicyError(path, field, message);
}
