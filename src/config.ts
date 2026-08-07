import { homedir } from "node:os";
import { loadTomlLayers, type TomlLayer } from "./inter-toml";
import { defaultModelFor } from "./provider-defaults";
import { stateStore } from "./store";
import type { Config, Profile, Provider } from "./types";

const PROVIDERS: Provider[] = ["claude", "codex", "opencode", "antigravity", "pi"];
const PROFILE_FIELDS = ["enabled", "label", "provider", "model", "env", "capabilities", "command"];
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]*$/i;

export class ProfileConfigError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    message: string,
  ) {
    super(`invalid profile config ${path} at ${field}: ${message}`);
    this.name = "ProfileConfigError";
  }
}

/**
 * The effective config for a scope. No cwd means user level: built-in defaults
 * merged with `~/.inter.toml`, no project layer. Every read that consults
 * profiles passes the cwd it is answering for, so a project's own file binds.
 */
export async function loadConfig(cwd?: string): Promise<Config> {
  return { profiles: await loadProfilesFor(cwd) };
}

/** The store layer alone — the only layer the profile edit routes persist to. */
export async function loadStoredConfig(): Promise<Config> {
  return { profiles: stateStore().listProfiles() };
}

export async function saveConfig(config: Config): Promise<void> {
  stateStore().saveProfiles(config.profiles);
}

export async function loadProfilesFor(cwd?: string): Promise<Profile[]> {
  return (await resolveProfileChain(cwd)).profiles;
}

export interface ProfileSource {
  /** Highest file that declared the id; "defaults" for store-only profiles. */
  source: string;
  /** Every file that declared the id, highest first. */
  sources: string[];
}

export interface ResolvedProfileChain {
  profiles: Profile[];
  sources: Map<string, ProfileSource>;
  /** Ids a lower layer offered but a higher layer's `[profiles]` table dropped. */
  excluded: Array<{ id: string; by: string }>;
}

export async function resolveProfileChain(cwd?: string): Promise<ResolvedProfileChain> {
  const base = stateStore().listProfiles();
  const layers = await loadTomlLayers(cwd);
  return resolveProfiles(base, layers.project, layers.user);
}

interface ProfileFields {
  enabled?: boolean;
  label?: string;
  provider?: Provider;
  model?: string;
  env?: Record<string, string>;
  capabilities?: string[];
  command?: string[];
}

interface ProfileEntry {
  path: string;
  fields: ProfileFields;
}

/**
 * The chain over the profile list. Two rules carry all the semantics.
 *
 * 1. A layer with a non-empty `[profiles]` table takes over the list: ids it
 *    does not mention are disabled in that scope. That is how a project file
 *    restricts itself to work profiles — it names the ones that may run, and
 *    everything below that it does not name stops being usable there. An
 *    empty table reads as absent, so an accidental `[profiles]` cannot disable
 *    every profile.
 * 2. A named id is merged field by field onto the same id below it, so a layer
 *    overrides only the fields it writes and a file may introduce an id no
 *    lower layer has (provider required then; model falls back to the
 *    provider's default).
 */
export function resolveProfiles(
  base: Profile[],
  project: TomlLayer | undefined,
  user: TomlLayer | undefined,
): ResolvedProfileChain {
  const userEntries = entries(user, "profiles");
  const projectEntries = entries(project, "profiles");
  const userTable = userEntries.size > 0;
  const projectTable = projectEntries.size > 0;

  const excluded: Array<{ id: string; by: string }> = [];
  let scope = new Set(base.map(({ id }) => id));
  if (userTable) {
    for (const id of scope) if (!userEntries.has(id)) excluded.push({ id, by: user!.path });
    scope = new Set(userEntries.keys());
  }
  if (projectTable) {
    for (const id of scope) if (!projectEntries.has(id)) excluded.push({ id, by: project!.path });
    scope = new Set(projectEntries.keys());
  }

  const byId = new Map(base.map((profile) => [profile.id, profile]));
  const ordered = [...base.map(({ id }) => id), ...userEntries.keys(), ...projectEntries.keys()]
    .filter((id, index, all) => scope.has(id) && all.indexOf(id) === index);

  const profiles = ordered.map((id) =>
    mergeProfile(byId.get(id), userEntries.get(id), projectEntries.get(id), id)
  );
  const sources = new Map<string, ProfileSource>();
  for (const id of ordered) {
    const declaring = [projectEntries.get(id), userEntries.get(id)]
      .filter((entry): entry is ProfileEntry => Boolean(entry))
      .map(({ path }) => path);
    sources.set(id, {
      source: declaring[0] ?? "defaults",
      sources: declaring.length > 0 ? declaring : ["defaults"],
    });
  }
  return { profiles, sources, excluded };
}

function entries(layer: TomlLayer | undefined, key: string): Map<string, ProfileEntry> {
  if (!layer || layer.root[key] === undefined) return new Map();
  return parseProfileTable(layer.root[key], layer.path, key);
}

function parseProfileTable(raw: unknown, path: string, key: string): Map<string, ProfileEntry> {
  const table = expectRecord(raw, path, key);
  const parsed = new Map<string, ProfileEntry>();
  for (const [id, value] of Object.entries(table)) {
    if (!PROFILE_ID.test(id)) {
      fail(path, `${key}.${id}`, "profile ids allow letters, digits, _ and - only (no dots)");
    }
    const fields = parseProfileFields(value, path, `${key}.${id}`);
    parsed.set(id, { path, fields });
  }
  return parsed;
}

function parseProfileFields(raw: unknown, path: string, field: string): ProfileFields {
  const entry = expectRecord(raw, path, field);
  rejectUnknownFields(entry, PROFILE_FIELDS, path, field);

  let enabled: boolean | undefined;
  if (entry.enabled !== undefined) {
    if (typeof entry.enabled !== "boolean") fail(path, `${field}.enabled`, "must be true or false");
    enabled = entry.enabled;
  }
  let label: string | undefined;
  if (entry.label !== undefined) {
    if (typeof entry.label !== "string" || !entry.label.trim()) {
      fail(path, `${field}.label`, "must be a non-empty string");
    }
    label = entry.label.trim();
  }
  let provider: Provider | undefined;
  if (entry.provider !== undefined) {
    if (typeof entry.provider !== "string" || !PROVIDERS.includes(entry.provider as Provider)) {
      fail(path, `${field}.provider`, `must be one of ${PROVIDERS.join(", ")}`);
    }
    provider = entry.provider as Provider;
  }
  let model: string | undefined;
  if (entry.model !== undefined) {
    if (typeof entry.model !== "string" || !entry.model.trim() || entry.model.length > 200) {
      fail(path, `${field}.model`, "must be a non-empty string of at most 200 characters");
    }
    model = entry.model.trim();
  }
  let env: Record<string, string> | undefined;
  if (entry.env !== undefined) {
    const table = expectRecord(entry.env, path, `${field}.env`);
    env = Object.fromEntries(Object.entries(table).map(([key, value]) => [key.trim(), String(value)]));
  }
  let capabilities: string[] | undefined;
  if (entry.capabilities !== undefined) {
    if (!Array.isArray(entry.capabilities)) fail(path, `${field}.capabilities`, "must be an array of strings");
    capabilities = entry.capabilities.map(String);
  }
  let command: string[] | undefined;
  if (entry.command !== undefined) {
    if (!Array.isArray(entry.command) || entry.command.length === 0) {
      fail(path, `${field}.command`, "must be a non-empty array of strings");
    }
    command = entry.command.map((value, index) => {
      if (typeof value !== "string" || !value.trim()) {
        fail(path, `${field}.command[${index}]`, "must be a non-empty string");
      }
      return value;
    });
  }
  return { ...(enabled !== undefined ? { enabled } : {}), ...(label !== undefined ? { label } : {}), ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}), ...(env !== undefined ? { env } : {}), ...(capabilities !== undefined ? { capabilities } : {}), ...(command !== undefined ? { command } : {}) };
}

function mergeProfile(
  base: Profile | undefined,
  user: ProfileEntry | undefined,
  project: ProfileEntry | undefined,
  id: string,
): Profile {
  if (!base) {
    const declaring = project ?? user;
    const provider = project?.fields.provider ?? user?.fields.provider;
    if (!provider) {
      fail(
        declaring!.path,
        `profiles.${id}.provider`,
        `no profile named ${id} exists below this file, so provider is required`,
      );
    }
    return {
      id,
      label: project?.fields.label ?? user?.fields.label ?? id,
      provider,
      model: project?.fields.model ?? user?.fields.model ?? defaultModelFor(provider),
      enabled: project?.fields.enabled ?? user?.fields.enabled ?? true,
      env: project?.fields.env ?? user?.fields.env ?? {},
      capabilities: project?.fields.capabilities ?? user?.fields.capabilities ?? [],
      ...(project?.fields.command ?? user?.fields.command
        ? { command: project?.fields.command ?? user?.fields.command }
        : {}),
    };
  }
  const merged = { ...base };
  for (const entry of [user, project]) {
    if (!entry) continue;
    const fields = entry.fields;
    if (fields.enabled !== undefined) merged.enabled = fields.enabled;
    if (fields.label !== undefined) merged.label = fields.label;
    if (fields.provider !== undefined) merged.provider = fields.provider;
    if (fields.model !== undefined) merged.model = fields.model;
    if (fields.env !== undefined) merged.env = fields.env;
    if (fields.capabilities !== undefined) merged.capabilities = fields.capabilities;
    if (fields.command !== undefined) merged.command = fields.command;
  }
  return merged;
}

/** Secret-like env values on every surface, files included. */
export function maskSecretEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [
    key,
    /(?:KEY|TOKEN|SECRET|PASS)/i.test(key) ? "••••••••" : value,
  ]));
}

export function profileEnv(profile: Profile): Record<string, string> {
  const home = Bun.env.HOME ?? homedir();
  return Object.fromEntries(Object.entries(profile.env).map(([key, value]) => [
    key,
    value.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home),
  ]));
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
  if (unknown) fail(path, `${field}.${unknown}`, "unknown field");
}

function fail(path: string, field: string, message: string): never {
  throw new ProfileConfigError(path, field, message);
}
