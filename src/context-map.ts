import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Stats } from "node:fs";
import { writeTargetsFrom } from "./adapters";
import { promptReadPaths } from "./prompt-paths";
import { scopeCoversPath } from "./task-scope";
import { stateStore } from "./store";
import { extractSymbols, type ExtractedSymbol, type MappedLang } from "./context-symbols";
import { DEFAULT_MAP_CONFIG, loadMapConfig } from "./worker-config";
import type { ContextFile, ContextMapRow, ContextSymbol, Task } from "./types";

export const MAP_SCHEME = 1;
/** The format's language table, v1: TypeScript plus Swift. */
const MAPPED_EXTENSIONS: Record<string, MappedLang> = { ts: "ts", tsx: "ts", swift: "swift" };
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".build", ".git"]);
const LOCKFILES = new Set([
  "package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock",
  "Cargo.lock", "Podfile.lock", "Gemfile.lock", "poetry.lock", "uv.lock",
]);
export const MAX_BUILD_FILES = 2_000;
export const BUILD_BUDGET_MS = 2_000;
export const MAX_SYMBOLS_PER_CWD = 5_000;
/** More stale rows than this in one sweep means a branch switch or a pull; rebuild instead of repairing inline. */
const MAX_INLINE_STALE = 50;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_CORRECTIONS = 20;
const MAX_CORRECTION_CHARS = 200;
const MAX_PURPOSE_CHARS = 100;

type RenderTier = "full" | "skeleton" | "index";

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

interface IgnoreGroup {
  /** The directory the .gitignore lives in, relative to cwd. */
  base: string;
  rules: IgnoreRule[];
}

interface Corrections {
  paths: string[];
  filePurposes: Map<string, string>;
  symbolPurposes: Map<string, Map<string, string>>;
}

interface SweepResult {
  files: ContextFile[];
  map: ContextMapRow | undefined;
  /** Rows left stale because the sweep bailed; render them path-only, never as fact. */
  staleKept: Set<string>;
}

// A fold or a rebuild reads and writes the store; jobs for one cwd run in
// order, so two workers settling at once fold one after the other and the
// disk re-read makes the second a no-op.
const contextJobs = new Map<string, Promise<void>>();

export function queueContextJob(cwd: string, job: () => void | Promise<void>): void {
  const run = async () => {
    // The fold is housekeeping: a failure leaves a stale map that the next
    // render repairs, so it must never take down a settle or a dispatch.
    try {
      await job();
    } catch {}
  };
  const next = (contextJobs.get(cwd) ?? Promise.resolve()).then(run);
  contextJobs.set(cwd, next);
}

/** The jobs queued so far, for tests that must not sleep on a guess. */
export function pendingContextJobs(): Promise<void>[] {
  return [...contextJobs.values()];
}

export function queueContextFold(cwd: string, taskId: string): void {
  queueContextJob(cwd, () => foldContextMap(cwd, taskId));
}

/** Tier 1 build, on first delegate into a cwd the map does not know yet. */
export function ensureContextMap(cwd: string): void {
  if (stateStore().getContextMap(cwd)) return;
  // The map is an accelerator; a build failure ships no block and must not
  // fail the dispatch that called it.
  try {
    buildContextMap(cwd);
  } catch {}
}

export interface BuildOptions {
  maxFiles?: number;
  budgetMs?: number;
  maxSymbols?: number;
}

/**
 * Walk the tree, extract every in-scope file, and write the map row. Bounded
 * by file count, wall time and symbol count; hitting any bound persists what
 * was reached and lands the map `partial`, because a map of the first files
 * beats a two-minute stall. Existing purposes survive for surviving symbols;
 * rows for files that vanished are dropped, but only when the walk was whole.
 */
export function buildContextMap(cwd: string, options: BuildOptions = {}): { partial: boolean } {
  const maxFiles = options.maxFiles ?? MAX_BUILD_FILES;
  const budgetMs = options.budgetMs ?? BUILD_BUDGET_MS;
  const maxSymbols = options.maxSymbols ?? MAX_SYMBOLS_PER_CWD;
  const startedAt = Date.now();
  const store = stateStore();
  const existing = new Map(store.listContextFiles(cwd).map((file) => [file.path, file]));
  const ignores: IgnoreGroup[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();
  let filesWalked = 0;
  let symbolCount = 0;
  let pendingProse = 0;
  let partial = false;

  const upsert = (path: string, lang: MappedLang): void => {
    const abs = resolve(cwd, path);
    let bytes: Buffer;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
      bytes = readFileSync(abs);
    } catch {
      return;
    }
    const extracted = extractSymbols(bytes.toString("utf8"), lang);
    if (extracted.symbols.length === 0 && !extracted.unparsed) return;
    if (symbolCount + extracted.symbols.length > maxSymbols) {
      partial = true;
      return;
    }
    seen.add(path);
    const previous = existing.get(path);
    const file = makeRow(cwd, path, lang, bytes, extracted.symbols, extracted.unparsed, previous, undefined, false);
    pendingProse += file.symbols.filter((symbol) => symbol.purpose === null).length;
    symbolCount += file.symbols.length;
    store.upsertContextFile(file);
  };

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes(".gitignore")) {
      try {
        ignores.push({
          base: dir === cwd ? "" : dir.slice(cwd.length + 1),
          rules: gitignoreRules(readFileSync(resolve(dir, ".gitignore"), "utf8")),
        });
      } catch {}
    }
    const dirs: string[] = [];
    for (const entry of entries.sort()) {
      if (partial || Date.now() - startedAt > budgetMs) break;
      const abs = resolve(dir, entry);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = abs === cwd ? "" : abs.slice(cwd.length + 1);
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry) || ignored(ignores, rel, true)) continue;
        dirs.push(abs);
        continue;
      }
      filesWalked++;
      if (filesWalked > maxFiles) {
        partial = true;
        break;
      }
      const dot = entry.lastIndexOf(".");
      const extension = dot > 0 ? entry.slice(dot + 1) : "";
      const lang = MAPPED_EXTENSIONS[extension];
      if (!lang || LOCKFILES.has(entry) || ignored(ignores, rel, false)) continue;
      upsert(rel, lang);
    }
    if (!partial && Date.now() - startedAt <= budgetMs) {
      for (const dir of dirs) walk(dir);
    }
  };
  walk(cwd);

  if (!partial) {
    for (const path of existing.keys()) {
      if (!seen.has(path)) store.deleteContextFile(cwd, path);
    }
  }
  store.setContextMap(cwd, {
    scheme: MAP_SCHEME,
    state: partial ? "partial" : "ready",
    builtAt: now,
    fileCount: seen.size,
    symbolCount,
    pendingProse,
    updatedAt: now,
  });
  return { partial };
}

/**
 * Fold a settled task's writes into the map. The task's stored events name the
 * candidate files; disk is the truth. Re-extracting from disk makes the fold
 * idempotent — the same tree always yields the same rows — and two workers
 * settling at once both read the same final bytes, so last write wins.
 */
export async function foldContextMap(cwd: string, taskId: string): Promise<void> {
  const store = stateStore();
  const task = store.getTask(taskId);
  if (!task) return;
  const events = store.listTaskEvents(taskId);
  const refused = new Set<string>();
  for (const event of events) {
    if (event.type === "scope_refusal") {
      refused.add(relativize(String(event.payload.path ?? ""), cwd));
    }
  }
  const corrections = parseCorrections(task.output ?? "", cwd);
  const candidates = new Set<string>();
  for (const event of events) {
    if (!event.type.startsWith("agent.")) continue;
    for (const target of writeTargetsFrom(event.payload)) {
      // A target stays in play only when resolving it lands inside the cwd:
      // relative worker paths resolve to it, absolute ones outside do not.
      const abs = resolve(cwd, target);
      const path = relativize(abs, cwd);
      if (path === abs || !mappedExtension(path)) continue;
      if (!refused.has(path)) candidates.add(path);
    }
  }
  for (const path of corrections.paths) candidates.add(path);
  for (const path of candidates) {
    healContextFile(cwd, path, corrections, true);
  }
  recountContextMap(cwd);
}

function recountContextMap(cwd: string): void {
  const files = stateStore().listContextFiles(cwd);
  stateStore().setContextMap(cwd, {
    fileCount: files.length,
    symbolCount: files.reduce((total, file) => total + file.symbols.length, 0),
    pendingProse: files.reduce(
      (total, file) => total + file.symbols.filter((symbol) => symbol.purpose === null).length,
      0,
    ),
  });
}

/**
 * One candidate file, brought back in line with disk. A missing or oversized
 * file drops the row; an unchanged digest changes nothing (the fold ran twice
 * or the write never landed); anything else re-extracts and reconciles the
 * stored purposes onto the surviving symbols by name — a rename reads as a
 * drop plus an insert, and no one tries to guess it.
 */
export function healContextFile(
  cwd: string,
  path: string,
  corrections?: Corrections,
  touch = false,
): ContextFile | undefined {
  const lang = mappedExtension(path);
  if (!lang) return undefined;
  const abs = resolve(cwd, path);
  let st: Stats;
  let bytes: Buffer;
  try {
    st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error("unmappable");
    bytes = readFileSync(abs);
  } catch {
    stateStore().deleteContextFile(cwd, path);
    return undefined;
  }
  const previous = stateStore().getContextFile(cwd, path);
  const digest = digestOf(bytes);
  if (previous && previous.digest === digest) {
    // The write never landed, but a correction may still name this file: the
    // stored symbols already are the fresh extraction, so prose applies to
    // them directly. Anything else is a no-op — the fold ran twice.
    const hints = corrections?.symbolPurposes.get(path);
    const filePurpose = corrections?.filePurposes.get(path);
    const symbols = hints
      ? previous.symbols.map((symbol) => hints.has(symbol.name)
        ? { ...symbol, purpose: hints.get(symbol.name)!, confirmed: false }
        : symbol)
      : previous.symbols;
    if (hints || filePurpose || touch) {
      const now = new Date().toISOString();
      const file = {
        ...previous,
        purpose: filePurpose ?? previous.purpose,
        symbols,
        updatedAt: now,
        ...(touch ? { touchCount: previous.touchCount + 1, touchedAt: now } : {}),
      };
      stateStore().upsertContextFile(file);
      return file;
    }
    return previous;
  }
  const extracted = extractSymbols(bytes.toString("utf8"), lang);
  const status = extracted.unparsed ? "unparsed" : "mapped";
  const file = makeRow(cwd, path, lang, bytes, extracted.symbols, status === "unparsed", previous, corrections, touch);
  stateStore().upsertContextFile(file);
  return file;
}

function makeRow(
  cwd: string,
  path: string,
  lang: MappedLang,
  bytes: Buffer,
  extracted: ExtractedSymbol[],
  unparsed: boolean,
  previous: ContextFile | undefined,
  corrections: Corrections | undefined,
  touch: boolean,
): ContextFile {
  const st = statSync(resolve(cwd, path));
  const now = new Date().toISOString();
  const symbols = reconcile(extracted, previous?.symbols ?? [], corrections?.symbolPurposes.get(path));
  const purpose = corrections?.filePurposes.get(path) ?? previous?.purpose ?? null;
  return {
    cwd,
    path,
    lang,
    purpose,
    lines: lineCount(bytes),
    size: st.size,
    mtimeMs: st.mtimeMs,
    digest: digestOf(bytes),
    symbols,
    status: unparsed ? "unparsed" : "mapped",
    touchCount: touch ? (previous?.touchCount ?? 0) + 1 : previous?.touchCount ?? 0,
    touchedAt: touch ? now : previous?.touchedAt ?? null,
    mappedAt: previous?.mappedAt ?? now,
    updatedAt: now,
  };
}

function reconcile(
  extracted: ExtractedSymbol[],
  stored: ContextSymbol[],
  hints?: Map<string, string>,
): ContextSymbol[] {
  const byName = new Map(stored.map((symbol) => [symbol.name, symbol]));
  return extracted.map((symbol) => {
    const previous = byName.get(symbol.name);
    const signatureChanged = previous !== undefined &&
      (previous.params !== symbol.params || previous.returns !== symbol.returns);
    const purpose = hints?.get(symbol.name) ?? previous?.purpose ?? null;
    return {
      line: symbol.line,
      kind: symbol.kind,
      name: symbol.name,
      ...(symbol.params ? { params: symbol.params } : {}),
      ...(symbol.returns ? { returns: symbol.returns } : {}),
      exported: symbol.exported,
      purpose,
      // A purpose survives only while the signature that justified it holds;
      // a worker correction stays unconfirmed until a describe pass agrees.
      confirmed: previous !== undefined && previous.confirmed && !signatureChanged && !hints?.has(symbol.name),
    };
  });
}

/**
 * The `## Map corrections` block of a settled output: `<path>:<symbol> — what
 * is actually true` or `<path> — what is actually true`. A hint is never a
 * fact — the fold re-extracts the file and applies prose only to symbols the
 * fresh extraction actually contains.
 */
export function parseCorrections(output: string, cwd: string): Corrections {
  const lines = output.split(/\r?\n/);
  let section = false;
  const paths: string[] = [];
  const filePurposes = new Map<string, string>();
  const symbolPurposes = new Map<string, Map<string, string>>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section = line === "## Map corrections";
      continue;
    }
    if (!section) continue;
    const match = line.match(/^(.+?)(?::([A-Za-z_$][\w$]*))?\s*—\s*(.+)$/);
    if (!match) continue;
    const path = match[1]!.trim();
    if (!path || path.includes("..") || path.startsWith("/") || !mappedExtension(path)) continue;
    const text = match[3]!.trim().slice(0, MAX_CORRECTION_CHARS);
    if (!text) continue;
    if (paths.length >= MAX_CORRECTIONS) break;
    if (!paths.includes(path)) paths.push(path);
    if (match[2]) {
      let byPath = symbolPurposes.get(path);
      if (!byPath) symbolPurposes.set(path, byPath = new Map());
      byPath.set(match[2], text.slice(0, MAX_PURPOSE_CHARS));
    } else {
      filePurposes.set(path, text.slice(0, MAX_PURPOSE_CHARS));
    }
  }
  return { paths, filePurposes, symbolPurposes };
}

/**
 * The stat sweep behind every render: repair stale rows inline, delete gone
 * ones, and when too much is stale in one sweep — a branch switch or a pull —
 * stop repairing, mark the map partial, and enqueue a full rebuild instead.
 */
export function sweepContextFiles(cwd: string): SweepResult {
  const store = stateStore();
  const rows = store.listContextFiles(cwd);
  const map = store.getContextMap(cwd);
  let stale = 0;
  for (const row of rows) {
    try {
      const st = statSync(resolve(cwd, row.path));
      if (st.size === row.size && st.mtimeMs === row.mtimeMs) continue;
    } catch {}
    stale++;
  }
  const bail = rows.length > 5 && (stale > MAX_INLINE_STALE || stale / rows.length > 0.3);
  if (bail) {
    store.setContextMap(cwd, { state: "partial" });
    queueContextJob(cwd, () => {
      buildContextMap(cwd);
    });
  }
  const files: ContextFile[] = [];
  const staleKept = new Set<string>();
  for (const row of rows) {
    let st: Stats | undefined;
    try {
      st = statSync(resolve(cwd, row.path));
    } catch {
      store.deleteContextFile(cwd, row.path);
      continue;
    }
    if (st.size === row.size && st.mtimeMs === row.mtimeMs) {
      files.push(row);
      continue;
    }
    if (bail) {
      staleKept.add(row.path);
      files.push(row);
      continue;
    }
    const healed = healContextFile(cwd, row.path);
    if (healed) files.push(healed);
  }
  return {
    files,
    map: bail ? stateStore().getContextMap(cwd) : map,
    staleKept,
  };
}

export interface MapQuery {
  paths?: string[];
  symbols?: string[];
  tier?: "full" | "skeleton";
}

export interface MapQueryResult {
  markdown: string;
  files: ContextFile[];
  outsideScope: number;
  gone: number;
}

/**
 * The worker's mid-task lookup. Every returned path is checked against the
 * read scope — a query must not hand over the shape of files the sandbox
 * refuses to read — and verified against disk, healing what it touches so an
 * answer is fresh as of the moment it was asked.
 */
export function queryContextMap(
  target: Pick<Task, "cwd" | "scope">,
  query: MapQuery,
): MapQueryResult {
  const store = stateStore();
  const rows = new Map<string, ContextFile>();
  const directorySources = new Set<string>();
  for (const path of query.paths ?? []) {
    if (path.endsWith("/")) {
      for (const row of store.listContextFilesUnder(target.cwd, path)) {
        rows.set(row.path, row);
        directorySources.add(row.path);
      }
    } else {
      const row = store.getContextFile(target.cwd, path);
      if (row) rows.set(row.path, row);
    }
  }
  for (const symbol of query.symbols ?? []) {
    const prefix = symbol.endsWith("*") ? symbol.slice(0, -1) : undefined;
    for (const row of store.listContextFiles(target.cwd)) {
      if (row.symbols.some((entry) => prefix ? entry.name.startsWith(prefix) : entry.name === symbol)) {
        rows.set(row.path, row);
      }
    }
  }
  let outsideScope = 0;
  let gone = 0;
  const files: ContextFile[] = [];
  for (const row of rows.values()) {
    if (!scopeCoversPath(target.scope.read, target.cwd, row.path)) {
      outsideScope++;
      continue;
    }
    const healed = healContextFile(target.cwd, row.path);
    if (!healed) {
      gone++;
      continue;
    }
    files.push(healed);
  }
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  const tierFor = (path: string): RenderTier =>
    query.tier ?? (directorySources.has(path) ? "skeleton" : "full");
  const lines = [mapHeader(target.cwd, stateStore().getContextMap(target.cwd))];
  renderBlocksInto(lines, files, tierFor, new Set());
  lines.push(
    ...(outsideScope > 0 ? [`(${outsideScope} path${outsideScope === 1 ? "" : "s"} omitted: outside this task's read scope)`] : []),
    ...(gone > 0 ? [`(${gone} path${gone === 1 ? "" : "s"} omitted: no longer on disk)`] : []),
  );
  return { markdown: lines.join("\n"), files, outsideScope, gone };
}

/**
 * The lookup both surfaces share: the HTTP route (scoped to a worker's read
 * grant) and the MCP tool (unrestricted — an MCP caller is not sandboxed).
 * `undefined` means the project turned the map off, which the route answers
 * with 404 and the tool with an error.
 */
export async function mapLookup(
  cwd: string,
  query: MapQuery,
  read: string[],
): Promise<MapQueryResult | undefined> {
  if (!(await mapLookupEnabled(cwd))) return undefined;
  return queryContextMap({ cwd, scope: { read, write: [] } }, query);
}

/**
 * The whole project's shape, for an MCP caller with no starting point: the
 * same tiered render the shipped block uses, unrestricted scope, and no curl
 * tail — the caller already has the tool that can page further.
 */
export async function projectSkeleton(cwd: string): Promise<string | undefined> {
  const config = await loadMapConfig(cwd).catch(() => DEFAULT_MAP_CONFIG);
  if (!config.lookup) return undefined;
  // The id only feeds the curl tail, which lookup: false drops, so "" is safe.
  return renderContextMap(
    { cwd, scope: { read: ["**"], write: [] }, prompt: "", id: "" },
    { shipChars: config.shipChars, lookup: false },
  ).text;
}

async function mapLookupEnabled(cwd: string): Promise<boolean> {
  return (await loadMapConfig(cwd).catch(() => DEFAULT_MAP_CONFIG)).lookup;
}

/**
 * The section a worker receives, after the memories block. `ship = false`
 * returns the prompt untouched — today's behaviour. The header and lookup
 * instruction always ship; the budget fills with full detail for what the
 * task is about, skeletons for the rest of its read scope, and an index for
 * whatever is left, with the tail pointed at instead of truncated.
 */
export function contextMapSection(
  prompt: string,
  task: Task,
  config: { ship: boolean; shipChars: number; lookup: boolean },
): string {
  if (!config.ship) return prompt;
  const rendered = renderContextMap(task, config);
  return rendered.text ? `${prompt}\n\n${rendered.text}` : prompt;
}

export function renderContextMap(
  task: Pick<Task, "cwd" | "scope" | "prompt" | "id">,
  config: { shipChars: number; lookup: boolean },
): { text: string; filesShown: number; filesOmitted: number } {
  const { files, map, staleKept } = sweepContextFiles(task.cwd);
  const cwd = task.cwd;
  const writeScope = new Set<string>();
  const promptScope = new Set<string>();
  const readScope = new Set<string>();
  for (const file of files) {
    if (scopeCoversPath(task.scope.write, cwd, file.path)) writeScope.add(file.path);
    else if (scopeCoversPath(task.scope.read, cwd, file.path)) {
      if (promptReadPaths(task.prompt, cwd).includes(file.path)) promptScope.add(file.path);
      else readScope.add(file.path);
    }
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const fixed = [lookupInstruction(task, config.lookup), mapHeader(cwd, map)];
  const lines = [...fixed];
  let budget = Math.max(0, config.shipChars - fixed.join("\n").length);
  const shown = new Set<string>();
  let filesOmitted = 0;
  let directory: string | undefined;
  const emit = (file: ContextFile, tier: RenderTier): boolean => {
    const rendered = renderFile(file, tier);
    if (rendered.length + 1 > budget) return false;
    const dir = dirname(file.path);
    if (dir !== directory) {
      directory = dir;
      lines.push(`## ${dir === "." ? "./" : `${dir}/`}`);
    }
    lines.push(rendered);
    budget -= rendered.length + 1;
    return true;
  };
  // Fill order: what the task is about in full, then the rest of its read
  // scope as skeletons, thinning to index lines as the budget runs out.
  const groups: Array<[RenderTier, Set<string>]> = [
    ["full", writeScope],
    ["full", promptScope],
    ["skeleton", readScope],
  ];
  for (const [tier, scope] of groups) {
    for (const path of [...scope].sort()) {
      const file = byPath.get(path);
      if (!file || shown.has(path)) continue;
      const fileTier = staleKept.has(path) ? "index" : tier;
      let emitted = emit(file, fileTier);
      if (!emitted && fileTier === "full") emitted = emit(file, "skeleton");
      if (!emitted && fileTier === "full") emitted = emit(file, "index");
      if (!emitted && fileTier === "skeleton") emitted = emit(file, "index");
      if (emitted) shown.add(path);
      else filesOmitted++;
    }
  }
  lines.push(
    ...(filesOmitted > 0
      ? [`(${filesOmitted} further file${filesOmitted === 1 ? "" : "s"} not shown${config.lookup
        ? ` — query them: curl -s '${lookupBaseUrl()}/api/map?task=${task.id}&path=<dir>/'`
        : ""})`]
      : []),
  );
  return { text: lines.join("\n"), filesShown: shown.size, filesOmitted };
}

function renderBlocksInto(
  lines: string[],
  files: ContextFile[],
  tierFor: (path: string) => RenderTier,
  staleKept: Set<string>,
): void {
  let directory: string | undefined;
  for (const file of files) {
    const dir = dirname(file.path);
    if (dir !== directory) {
      directory = dir;
      lines.push(`## ${dir === "." ? "./" : `${dir}/`}`);
    }
    lines.push(renderFile(file, staleKept.has(file.path) ? "index" : tierFor(file.path)));
  }
}

function renderFile(file: ContextFile, tier: RenderTier): string {
  if (tier === "index") return `### ${file.path} · ${file.lines}L`;
  if (tier === "skeleton") {
    return `### ${file.path} · ${file.lines}L${file.purpose ? ` — ${file.purpose}` : ""}`;
  }
  if (file.status === "unparsed") return `### ${file.path} · ${file.lines}L · ${file.digest} — (symbols unavailable)`;
  const header = `### ${file.path} · ${file.lines}L · ${file.digest}`;
  const purposes = file.purpose ? [file.purpose] : [];
  const overCap = file.symbols.length > MAX_SYMBOLS_PER_FILE;
  const symbols = overCap ? file.symbols.filter((symbol) => symbol.exported) : file.symbols;
  const internal = file.symbols.length - symbols.length;
  const symbolLines = symbols.map(renderSymbol);
  const capped = internal > 0 ? [...symbolLines, `- (+${internal} internal symbols)`] : symbolLines;
  return [header, ...purposes, ...capped].join("\n");
}

function renderSymbol(symbol: ContextSymbol): string {
  const params = symbol.params ? `(${symbol.params})` : "()";
  const returns = symbol.returns ? ` → ${symbol.returns}` : "";
  const flags = [
    ...(symbol.exported ? [] : ["int"]),
    ...(symbol.purpose === null || !symbol.confirmed ? ["?"] : []),
  ];
  const flagText = flags.length > 0 ? ` ·${flags.join(" ·")}` : "";
  const purpose = symbol.purpose ? ` — ${symbol.purpose}` : "";
  return `- L${symbol.line} ${symbol.kind} ${symbol.name}${params}${returns}${flagText}${purpose}`;
}

function mapHeader(cwd: string, map: ContextMapRow | undefined): string {
  return [
    `# Context map — ${cwd}`,
    `scheme ${MAP_SCHEME} · ${map?.fileCount ?? 0} files · ${map?.symbolCount ?? 0} symbols · generated ${map?.builtAt ?? new Date().toISOString()}`,
  ].join("\n");
}

function lookupInstruction(task: { id: string }, lookup: boolean): string {
  const base = lookupBaseUrl();
  return [
    "## Project map",
    "An index of this project, built by Inter from earlier tasks. It says where things are.",
    "It is not authoritative about what they do, and it can be behind the code.",
    "",
    "Use it to go straight to a file instead of searching. Before you act on an entry —",
    "edit it, call it, or report it — open the file and confirm the symbol is there.",
    "Where this map and the file disagree, the file is right.",
    ...(lookup
      ? [
        "",
        "Not everything is listed below. To see a directory, a file, or where a symbol is defined:",
        "",
        `    curl -s '${base}/api/map?task=${task.id}&path=src/store/'`,
        `    curl -s '${base}/api/map?task=${task.id}&symbol=writeTargetsFrom'`,
        "",
        "Answers come back in this same format, in well under a second. `path` takes a file or a",
        "directory ending in `/`, `symbol` takes a name; both can be repeated in one call, and one",
        "call with three paths beats three calls. It searches structure only — for anything about",
        "file *contents*, use your normal search tools. If curl fails or returns nothing, stop",
        "asking and read the file directly; this index is an accelerator, never a dependency.",
      ]
      : []),
    "",
    "If an entry is wrong or missing, list it in your final report under `## Map corrections`,",
    "one line each: `<path>:<symbol> — <what is actually true>`. You cannot edit the map yourself.",
  ].join("\n");
}

function lookupBaseUrl(): string {
  return Bun.env.INTER_BROKER_URL ?? `http://127.0.0.1:${Bun.env.INTER_PORT ?? 7331}`;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 7);
}

function lineCount(bytes: Buffer): number {
  const text = bytes.toString("utf8");
  if (text === "") return 0;
  const count = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? count - 1 : count;
}

function mappedExtension(path: string): MappedLang | undefined {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? MAPPED_EXTENSIONS[path.slice(dot + 1)] : undefined;
}

function relativize(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function gitignoreRules(source: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (!pattern) continue;
    try {
      rules.push({ negated, dirOnly, anchored, regex: gitignoreRegex(pattern, anchored) });
    } catch {}
  }
  return rules;
}

function gitignoreRegex(pattern: string, anchored: boolean): RegExp {
  let out = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]!;
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        at++;
        if (pattern[at + 1] === "/") at++;
        out += "(?:.*/)?";
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\+.^$|(){}[]".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

function ignored(ignores: IgnoreGroup[], relPath: string, isDir: boolean): boolean {
  let verdict = false;
  for (const group of ignores) {
    const prefix = group.base === "" ? "" : `${group.base}/`;
    if (!relPath.startsWith(prefix)) continue;
    const rel = prefix === "" ? relPath : relPath.slice(prefix.length);
    for (const rule of group.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rel)) verdict = !rule.negated;
    }
  }
  return verdict;
}
