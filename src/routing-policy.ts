import { join, resolve } from "node:path";
import type { RoutePreference, TaskClass } from "./model-router";

const POLICY_FILE = ".inter.toml";
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
  path: string;
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

export async function loadRoutingPolicy(cwd: string): Promise<RoutingPolicy | undefined> {
  const path = join(resolve(cwd), POLICY_FILE);
  let source: string;
  try {
    source = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(source);
  } catch (error) {
    throw new RoutingPolicyError(path, "syntax", errorMessage(error));
  }
  return validatePolicy(raw, path);
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

/// Position of the first allow rule matching this model. Entries are written
/// best-first, so this is the preference order to use when a caller has already
/// named the profile and only the model is left to choose.
export function allowRank(
  route: RoutingPolicyRoute,
  providerId: string,
  modelId: string,
): number {
  const provider = normalizeId(providerId);
  const model = normalizeId(modelId);
  const index = route.allow.findIndex((rule) =>
    rule.provider === provider && globMatches(rule.model, model)
  );
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

export function normalizeTaskClass(value: string): TaskClass | undefined {
  const normalized = value.trim().toLowerCase();
  return TASK_CLASSES.find((taskClass) => taskClass === normalized);
}

function validatePolicy(raw: unknown, path: string): RoutingPolicy {
  const root = expectRecord(raw, path, "root");
  rejectUnknownFields(root, ["version", "routes"], path, "root");
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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
