import { join, resolve } from "node:path";

const CONFIG_FILE = ".inter.toml";
const WORKER_FIELDS = ["tldr", "tldr_sentences", "conduct", "report"];
const MAX_RULES = 20;
const MAX_RULE_CHARS = 500;
const MAX_SECTION_CHARS = 4_000;
const SENTENCE_RANGE = /^([1-9]\d?)(?:-([1-9]\d?))?$/;

/**
 * The parts of the worker preamble a project owns. Everything else in
 * `<inter_protocol>` is mechanism the broker parses, so it is not expressible
 * here — see docs/worker-rules.md.
 */
export interface WorkerRules {
  tldr: boolean;
  tldrSentences: string;
  conduct: string[];
  report: string[];
}

/** What a project with no `[worker]` table ships. */
export const DEFAULT_WORKER_RULES: WorkerRules = {
  tldr: true,
  tldrSentences: "1-3",
  conduct: [],
  report: [],
};

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
  const path = join(resolve(cwd), CONFIG_FILE);
  let source: string;
  try {
    source = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFile(error)) return DEFAULT_WORKER_RULES;
    throw error;
  }

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(source);
  } catch (error) {
    throw new WorkerRulesError(path, "syntax", errorMessage(error));
  }
  return validateWorkerRules(raw, path);
}

function validateWorkerRules(raw: unknown, path: string): WorkerRules {
  const root = expectRecord(raw, path, "root");
  if (root.worker === undefined) return DEFAULT_WORKER_RULES;
  const worker = expectRecord(root.worker, path, "worker");
  const unknown = Object.keys(worker).find((key) => !WORKER_FIELDS.includes(key));
  if (unknown) fail(path, `worker.${unknown}`, `unknown field; expected ${WORKER_FIELDS.join(", ")}`);

  // Per key, so a project that sets one knob keeps the defaults for the rest.
  return {
    tldr: expectBoolean(worker.tldr, path, "worker.tldr") ?? DEFAULT_WORKER_RULES.tldr,
    tldrSentences: sentenceRange(worker.tldr_sentences, path) ?? DEFAULT_WORKER_RULES.tldrSentences,
    conduct: ruleList(worker.conduct, path, "worker.conduct"),
    report: ruleList(worker.report, path, "worker.report"),
  };
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

function ruleList(value: unknown, path: string, field: string): string[] {
  if (value === undefined) return [];
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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
