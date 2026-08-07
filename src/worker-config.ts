import { loadTomlLayers, TomlConfigError } from "./inter-toml";

const CONFIG_FILE = ".inter.toml";
const WORKER_FIELDS = ["tldr", "tldr_sentences", "tldr_template", "builtins", "conduct", "report"];
const MAP_FIELDS = ["ship", "ship_chars", "lookup", "describe_profile", "describe_model", "describe_effort"];
const MAX_RULES = 20;
const MAX_RULE_CHARS = 500;
const MAX_SECTION_CHARS = 4_000;
const SENTENCE_RANGE = /^([1-9]\d?)(?:-([1-9]\d?))?$/;
const COUNT_PLACEHOLDER = "{count}";

/** The wording of the TL;DR rule, with `{count}` standing in for the sentence count `tldr_sentences` resolves to. */
const DEFAULT_TLDR_TEMPLATE =
  "Open your final report with `## TL;DR` — {count} stating what was done or found and the outcome. " +
  "Detail follows after; this applies to your final answer, not to intermediate messages.";

/**
 * How every worker is told to work, shipped whether or not the caller wrote a
 * brief that says so. Each line answers a way workers were observed to burn a
 * run: improvising around a blocker, retrying a command that already failed,
 * throwing away finished work, reporting a check it never ran, and rewriting
 * work that was already on disk.
 */
export const BUILTIN_CONDUCT: readonly string[] = [
  "Blocked means stop. A command that will not run, a missing credential, an account or signup, a permission denial, a path outside your scope, a decision this brief does not answer — stop and report it, naming the blocker and the one decision you need.",
  "Do not work around a blocker. No retry loops, no second tool for the same job, no creating accounts, no linking or authenticating anything, no editing outside your write scope, no faking or stubbing the result.",
  "One attempt, then report. If the same command fails twice the same way, that is the answer — quote the error exactly and stop.",
  "Partial work is a valid result. Finish what is unblocked, then report what you stopped on. Never discard finished work to keep trying.",
  "Never report a result you did not observe. If you could not run a check, say so and say why, instead of describing an outcome you did not see.",
  "Build on what is already there. When the brief says something is done, read it and continue from it instead of starting over.",
];

/**
 * The shape of the summary, shipped alongside the TL;DR rule and only when
 * that rule is on, since both describe the same block. Callers read the
 * summary and rarely the detail, so a report that opens in prose costs them
 * the context it was meant to save.
 */
export const BUILTIN_REPORT: readonly string[] = [
  "Write that TL;DR as bullets — one idea per line, never a paragraph — and make it stand alone: no bullet may need the detail below it to make sense.",
  'Cover in it, one line each: the verdict, done or partial or blocked; what changed or was found, with every changed path on its own line; each check you ran and its result, quoting any failure exactly; and what is left, broken or uncertain, or "nothing".',
];

/**
 * The parts of the worker preamble a project owns. Everything else in
 * `<inter_protocol>` is mechanism the broker parses, so it is not expressible
 * here — see docs/worker-rules.md.
 */
export interface WorkerRules {
  tldr: boolean;
  tldrSentences: string;
  tldrTemplate: string;
  /** Whether {@link BUILTIN_CONDUCT} and {@link BUILTIN_REPORT} ship. */
  builtins: boolean;
  conduct: string[];
  report: string[];
}

/** What a project with no `[worker]` table ships. */
export const DEFAULT_WORKER_RULES: WorkerRules = {
  tldr: true,
  tldrSentences: "1-3",
  tldrTemplate: DEFAULT_TLDR_TEMPLATE,
  builtins: true,
  conduct: [],
  report: [],
};

/**
 * The context map knobs a project owns. `ship = false` is today's behaviour —
 * no map block, no per-dispatch token tax — and the A/B the design runs is
 * `ship_chars` at 12,000 with `lookup` off against 6,000 with it on.
 */
export interface MapConfig {
  ship: boolean;
  shipChars: number;
  lookup: boolean;
  describeProfile?: string;
  describeModel?: string;
  describeEffort?: string;
}

export const DEFAULT_MAP_CONFIG: MapConfig = { ship: true, shipChars: 6_000, lookup: true };

export class WorkerRulesError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    message: string,
  ) {
    super(`invalid worker rules ${path} at ${field}: ${message}`);
    this.name = "WorkerRulesError";
  }
}

export async function loadWorkerRules(cwd: string): Promise<WorkerRules> {
  let layers;
  try {
    layers = await loadTomlLayers(cwd);
  } catch (error) {
    if (error instanceof TomlConfigError) {
      throw new WorkerRulesError(error.path, error.field, error.message);
    }
    throw error;
  }
  const project = layers.project ? parseWorkerRules(layers.project.root, layers.project.path) : undefined;
  const user = layers.user ? parseWorkerRules(layers.user.root, layers.user.path) : undefined;
  const pick = (key: keyof WorkerRules): WorkerRules[keyof WorkerRules] =>
    written(project, key) ?? written(user, key) ?? DEFAULT_WORKER_RULES[key];
  return {
    tldr: pick("tldr") as boolean,
    tldrSentences: pick("tldrSentences") as string,
    tldrTemplate: pick("tldrTemplate") as string,
    builtins: pick("builtins") as boolean,
    conduct: pick("conduct") as string[],
    report: pick("report") as string[],
  };
}

interface WorkerRulesSource {
  rules: WorkerRules;
  /** The keys the table actually wrote, so a higher layer only overrides what it wrote. */
  written: Set<keyof WorkerRules>;
}

function written<T, K extends keyof T>(
  source: { rules: T; written: Set<keyof T> } | undefined,
  key: K,
): T[K] | undefined {
  return source?.written.has(key) ? source.rules[key] : undefined;
}

/**
 * One layer's `[worker]` table, validated against the shipped defaults per key
 * (so a table that sets one knob is a complete file on its own) and tagged
 * with the keys it actually wrote, which is what the chain merge reads.
 */
function parseWorkerRules(raw: unknown, path: string): WorkerRulesSource {
  const root = expectRecord(raw, path, "root");
  if (root.worker === undefined) return { rules: DEFAULT_WORKER_RULES, written: new Set() };
  const worker = expectRecord(root.worker, path, "worker");
  const unknown = Object.keys(worker).find((key) => !WORKER_FIELDS.includes(key));
  if (unknown) fail(path, `worker.${unknown}`, `unknown field; expected ${WORKER_FIELDS.join(", ")}`);

  const writtenKeys = new Set<keyof WorkerRules>();
  const set = <K extends keyof WorkerRules>(key: K, value: WorkerRules[K] | undefined): WorkerRules[K] => {
    if (value === undefined) return DEFAULT_WORKER_RULES[key];
    writtenKeys.add(key);
    return value;
  };
  const rules: WorkerRules = {
    tldr: set("tldr", expectBoolean(worker.tldr, path, "worker.tldr")),
    tldrSentences: set("tldrSentences", sentenceRange(worker.tldr_sentences, path)),
    tldrTemplate: set("tldrTemplate", tldrTemplate(worker.tldr_template, path)),
    builtins: set("builtins", expectBoolean(worker.builtins, path, "worker.builtins")),
    conduct: set("conduct", ruleList(worker.conduct, path, "worker.conduct")),
    report: set("report", ruleList(worker.report, path, "worker.report")),
  };
  return { rules, written: writtenKeys };
}

/**
 * The `[map]` table, resolved the same way `[worker]` is: project file wins
 * per key, then the user file, then the shipped defaults. A table that sets
 * one knob keeps the defaults for the rest, and a missing table is the
 * default. A malformed table throws — callers that must never fail a run (the
 * shipped prompt, the lookup route) catch it and fall back to
 * {@link DEFAULT_MAP_CONFIG}.
 */
export async function loadMapConfig(cwd: string): Promise<MapConfig> {
  let layers;
  try {
    layers = await loadTomlLayers(cwd);
  } catch (error) {
    if (error instanceof TomlConfigError) {
      throw new WorkerRulesError(error.path, error.field, error.message);
    }
    throw error;
  }
  const project = layers.project ? parseMapConfig(layers.project.root, layers.project.path) : undefined;
  const user = layers.user ? parseMapConfig(layers.user.root, layers.user.path) : undefined;
  const pick = <K extends keyof MapConfig>(key: K): MapConfig[K] =>
    written(project, key) ?? written(user, key) ?? DEFAULT_MAP_CONFIG[key];
  return {
    ship: pick("ship"),
    shipChars: pick("shipChars"),
    lookup: pick("lookup"),
    ...(pick("describeProfile") !== undefined ? { describeProfile: pick("describeProfile") } : {}),
    ...(pick("describeModel") !== undefined ? { describeModel: pick("describeModel") } : {}),
    ...(pick("describeEffort") !== undefined ? { describeEffort: pick("describeEffort") } : {}),
  };
}

interface MapConfigSource {
  rules: MapConfig;
  written: Set<keyof MapConfig>;
}

function parseMapConfig(raw: unknown, path: string): MapConfigSource {
  const root = expectRecord(raw, path, "root");
  if (root.map === undefined) return { rules: DEFAULT_MAP_CONFIG, written: new Set() };
  const map = expectRecord(root.map, path, "map");
  const unknown = Object.keys(map).find((key) => !MAP_FIELDS.includes(key));
  if (unknown) fail(path, `map.${unknown}`, `unknown field; expected ${MAP_FIELDS.join(", ")}`);
  const writtenKeys = new Set<keyof MapConfig>();
  const set = <K extends keyof MapConfig>(key: K, value: MapConfig[K] | undefined): MapConfig[K] => {
    if (value === undefined) return DEFAULT_MAP_CONFIG[key];
    writtenKeys.add(key);
    return value;
  };
  const describe = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) fail(path, field, "must be a non-empty string");
    return value.trim();
  };
  return {
    rules: {
      ship: set("ship", expectBoolean(map.ship, path, "map.ship")),
      shipChars: set("shipChars", shipChars(map.ship_chars, path)),
      lookup: set("lookup", expectBoolean(map.lookup, path, "map.lookup")),
      describeProfile: set("describeProfile", describe(map.describe_profile, "map.describe_profile")),
      describeModel: set("describeModel", describe(map.describe_model, "map.describe_model")),
      describeEffort: set("describeEffort", describe(map.describe_effort, "map.describe_effort")),
    },
    written: writtenKeys,
  };
}

function shipChars(value: unknown, path: string): number | undefined {
  const field = "map.ship_chars";
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200_000) {
    fail(path, field, "must be an integer between 1 and 200000");
  }
  return value;
}

function expectBoolean(value: unknown, path: string, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(path, field, "must be true or false");
  return value;
}

function sentenceRange(value: unknown, path: string): string | undefined {
  const field = "worker.tldr_sentences";
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(path, field, 'must be a count like "2" or a range like "1-3"');
  const match = value.trim().match(SENTENCE_RANGE);
  if (!match) fail(path, field, 'must be a count like "2" or a range like "1-3"');
  const low = Number(match[1]);
  const high = match[2] === undefined ? undefined : Number(match[2]);
  if (high !== undefined && high < low) fail(path, field, "range must not end below where it starts");
  return high === undefined ? `${low}` : `${low}-${high}`;
}

function tldrTemplate(value: unknown, path: string): string | undefined {
  const field = "worker.tldr_template";
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) fail(path, field, "must be a non-empty string");
  const template = value.trim();
  if (/[\r\n]/.test(template)) fail(path, field, "must be a single line");
  if (template.length > MAX_RULE_CHARS) fail(path, field, `must be at most ${MAX_RULE_CHARS} characters`);
  if (!template.includes(COUNT_PLACEHOLDER)) fail(path, field, `must include the ${COUNT_PLACEHOLDER} placeholder`);
  return template;
}

function ruleList(value: unknown, path: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, field, "must be an array of strings");
  if (value.length > MAX_RULES) fail(path, field, `must hold at most ${MAX_RULES} rules`);
  const rules = value.map((entry, index) => {
    const at = `${field}[${index}]`;
    if (typeof entry !== "string" || !entry.trim()) fail(path, at, "must be a non-empty string");
    const rule = entry.trim();
    // Each rule is one numbered line in the preamble; a rule that wraps would
    // read as an unnumbered instruction of its own.
    if (/[\r\n]/.test(rule)) fail(path, at, "must be a single line");
    if (rule.length > MAX_RULE_CHARS) fail(path, at, `must be at most ${MAX_RULE_CHARS} characters`);
    return rule;
  });
  const total = rules.reduce((sum, rule) => sum + rule.length, 0);
  if (total > MAX_SECTION_CHARS) fail(path, field, `must be at most ${MAX_SECTION_CHARS} characters in total`);
  return rules;
}

function expectRecord(value: unknown, path: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, field, "must be a table");
  }
  return value as Record<string, unknown>;
}

function fail(path: string, field: string, message: string): never {
  throw new WorkerRulesError(path, field, message);
}
