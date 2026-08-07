import type { ContextSymbol } from "./types";

/** One symbol as the extractor found it; purpose and confirmation are the map's, not the source's. */
export interface ExtractedSymbol {
  line: number;
  kind: ContextSymbol["kind"];
  name: string;
  params?: string;
  returns?: string;
  exported: boolean;
}

export type MappedLang = "ts" | "swift";

/** Files past this size are never read at all, let alone scanned. */
export const MAX_SYMBOL_FILE_BYTES = 500 * 1024;

const TS_EXPORT_STRIP = /^(?:export|declare|async|default|abstract)\s+/;
const TS_DECLARATIONS: Array<[RegExp, ContextSymbol["kind"]]> = [
  [/^function\s+([A-Za-z_$][\w$]*)/, "fn"],
  [/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^type\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^const\s+([A-Za-z_$][\w$]*)/, "const"],
];
const TS_SKIPPED_STARTS = /^(?:enum|const\s+enum|namespace|interface|import|\{|\*|type\s*\{)/;
const SWIFT_ATTRIBUTE = /^(?:@[\w.]+(?:\s*\([^)]*\))?\s*)+/;
const SWIFT_DECLARATIONS: Array<[RegExp, ContextSymbol["kind"]]> = [
  [/^func\s+([A-Za-z_][\w]*)/, "fn"],
  [/^struct\s+([A-Za-z_][\w]*)/, "struct"],
  [/^class\s+([A-Za-z_][\w]*)/, "class"],
  [/^enum\s+([A-Za-z_][\w]*)/, "enum"],
  [/^extension\s+([A-Za-z_][\w]*)/, "ext"],
];
const SWIFT_SKIPPED_STARTS = /^(?:import|typealias|protocol|var|let|init|deinit|operator|precedencegroup|subscript|#)/;
/** More than four parameters collapses to the first three, per the format rule. */
const MAX_PARAMS = 4;
const COLLAPSED_PARAMS = 3;

interface ScanState {
  depth: number;
  quote: "'" | '"' | "`" | null;
  triple: boolean;
  escaped: boolean;
  blockComment: boolean;
}

/**
 * The v1 scanner is line-based: it recognises module-scope declarations by
 * their first line and balances braces for everything after that. That is
 * deliberate. A full parser buys exactness on declaration boundaries and
 * loses on cost and on the real failure mode this feature exists to survive —
 * a half-finished edit that a real parser would refuse outright, where this
 * scanner still reports the symbols it can see.
 */
export function extractSymbols(source: string, lang: MappedLang): { symbols: ExtractedSymbol[]; unparsed: boolean } {
  const lines = source.split(/\r?\n/);
  // A TS scan throw is a parse failure. Swift has no scanner, so only brace
  // balance can judge it — and balance alone decides both languages' shape.
  const scanFailed = lang === "ts" && tsExports(source) === undefined;
  const unparsed = scanFailed || !balanced(lines, lang);
  if (unparsed) return { symbols: [], unparsed: true };
  const symbols = lang === "ts" ? scanTypeScript(lines, tsExports(source)!) : scanSwift(lines);
  return { symbols, unparsed: false };
}

function tsExports(source: string): Set<string> | undefined {
  try {
    const scanned = new Bun.Transpiler({ loader: "ts" }).scan(source);
    return new Set(scanned.exports);
  } catch {
    return undefined;
  }
}

/** Brace balance over the whole file, comments and strings ignored. */
function balanced(lines: string[], lang: MappedLang): boolean {
  const state: ScanState = { depth: 0, quote: null, triple: false, escaped: false, blockComment: false };
  for (const line of lines) scanLine(line, state);
  return state.depth === 0 && !state.blockComment;
}

function scanTypeScript(lines: string[], exports: Set<string>): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const state: ScanState = { depth: 0, quote: null, triple: false, escaped: false, blockComment: false };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (state.depth === 0 && !state.blockComment && !inString(state)) {
      const symbol = tsDeclaration(lines, index, exports);
      if (symbol) symbols.push(symbol);
    }
    scanLine(line, state);
  }
  return symbols;
}

function tsDeclaration(lines: string[], start: number, exports: Set<string>): ExtractedSymbol | undefined {
  const line = lines[start]!.trim();
  const hadExport = line.startsWith("export");
  const stripped = stripTsPrefixes(line);
  if (TS_SKIPPED_STARTS.test(stripped)) return undefined;
  for (const [pattern, kind] of TS_DECLARATIONS) {
    const match = stripped.match(pattern);
    if (!match) continue;
    const name = match[1]!;
    if (kind === "fn") {
      const signature = declarationText(lines, start, true);
      return {
        line: start + 1,
        kind,
        name,
        ...signatureFrom(signature, "ts"),
        exported: hadExport || exports.has(name),
      };
    }
    if (kind === "const") {
      const text = declarationText(lines, start, false);
      const arrow = text.includes("=>");
      if (arrow && lineSpan(text) < 3) return undefined;
      return {
        line: start + 1,
        kind,
        name,
        ...(arrow ? signatureFrom(text, "ts") : {}),
        exported: hadExport || exports.has(name),
      };
    }
    return { line: start + 1, kind, name, exported: hadExport || exports.has(name) };
  }
  return undefined;
}

/** Strips modifier prefixes one at a time: `export default async function` passes each in turn. */
function stripTsPrefixes(line: string): string {
  let out = line;
  while (true) {
    const next = out.replace(TS_EXPORT_STRIP, "");
    if (next === out) return out;
    out = next;
  }
}

/**
 * The declaration's text from its first line to the body brace or the
 * statement terminator, comments and strings ignored. `fn` ends at the body
 * `{`; `const` ends at the `;` that closes it, so an object literal never
 * stops the scan early.
 */
function declarationText(lines: string[], start: number, stopsAtBody: boolean): string {
  const state: ScanState = { depth: 0, quote: null, triple: false, escaped: false, blockComment: false };
  let text = "";
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    text += line;
    if (index > start) text += "\n";
    for (let at = 0; at < line.length; at++) {
      const char = line[at]!;
      if (state.quote) {
        if (state.escaped) state.escaped = false;
        else if (char === "\\") state.escaped = true;
        else if (char === state.quote) {
          if (state.triple && line.slice(at, at + 3) === '"""') at += 2;
          state.quote = null;
          state.triple = false;
        }
        continue;
      }
      if (state.blockComment) {
        if (char === "*" && line[at + 1] === "/") {
          state.blockComment = false;
          at++;
        }
        continue;
      }
      if (char === "/" && line[at + 1] === "/") break;
      if (char === "/" && line[at + 1] === "*") {
        state.blockComment = true;
        at++;
        continue;
      }
      if (char === '"' && line.slice(at, at + 3) === '"""') {
        state.quote = '"';
        state.triple = true;
        at += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        state.quote = char;
        continue;
      }
      if (char === "(") state.depth += 2;
      else if (char === ")") state.depth -= 2;
      else if (char === "{") {
        if (stopsAtBody && state.depth === 0) return text;
        state.depth += 1;
      } else if (char === "}" && --state.depth < 0) return text;
      else if (char === ";" && state.depth === 0) return text;
    }
  }
  return text;
}

/** Parentheses ride the same counter, offset by 2 so a `(` never reads as a body brace. */
function signatureFrom(text: string, lang: MappedLang): { params?: string; returns?: string } {
  const open = text.indexOf("(");
  if (open < 0) return {};
  const paramsText = betweenMatching(text, open, "(", ")");
  if (paramsText === undefined) return {};
  const params = paramsFrom(paramsText, lang);
  const afterClose = open + paramsText.length + 2;
  const rest = text.slice(afterClose);
  let returns: string | undefined;
  if (lang === "ts") {
    const arrow = rest.indexOf("=>");
    const boundary = arrow >= 0 ? arrow : text.indexOf("{", open) - afterClose;
    const region = boundary >= 0 ? rest.slice(0, boundary) : rest;
    returns = region.trim().replace(/^:\s*/, "");
  } else {
    const arrow = rest.indexOf("->");
    if (arrow >= 0) returns = rest.slice(arrow + 2).split("{")[0]!.trim();
  }
  return {
    ...(params ? { params } : {}),
    ...(returns && returns.length > 0 ? { returns } : {}),
  };
}

function betweenMatching(text: string, open: number, openChar: string, closeChar: string): string | undefined {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === openChar) depth++;
    else if (text[at] === closeChar) {
      depth--;
      if (depth === 0) return text.slice(open + 1, at);
    }
  }
  return undefined;
}

function paramsFrom(paramsText: string, lang: MappedLang): string | undefined {
  const segments = splitTopLevel(paramsText, ",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  const shown = segments.length > MAX_PARAMS ? segments.slice(0, COLLAPSED_PARAMS) : segments;
  const names = shown.map((segment) => paramName(segment, lang));
  const joined = names.join(", ");
  return segments.length > MAX_PARAMS ? `${joined}, …` : joined;
}

function paramName(segment: string, lang: MappedLang): string {
  if (lang === "swift") {
    // Swift labels sit before the real name: `label a: Int`, `_ a: Int`.
    const colon = topLevelColon(segment);
    if (colon >= 0) {
      const tokens = segment.slice(0, colon).trim().split(/\s+/);
      const name = tokens.at(-1);
      if (name && /^[A-Za-z_][\w]*$/.test(name)) return name;
    }
    const first = segment.split(/\s+/)[0];
    return first && /^[A-Za-z_][\w]*$/.test(first) ? first : "";
  }
  if (segment.startsWith("{") || segment.startsWith("[")) return segment.split(/[:=]/)[0]!.trim();
  if (segment.startsWith("...")) return `...${segment.slice(3).match(/[A-Za-z_$][\w$]*/)?.[0] ?? ""}`;
  return segment.match(/^([A-Za-z_$][\w$]*\??)/)?.[1] ?? "";
}

function topLevelColon(segment: string): number {
  let depth = 0;
  for (let at = 0; at < segment.length; at++) {
    const char = segment[at]!;
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === ":" && depth === 0) return at;
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "{" || char === "[" || char === "<") depth++;
    else if (char === ")" || char === "}" || char === "]" || char === ">") depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function scanSwift(lines: string[]): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const state: ScanState = { depth: 0, quote: null, triple: false, escaped: false, blockComment: false };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (state.depth === 0 && !state.blockComment && !inString(state)) {
      const symbol = swiftDeclaration(lines, index);
      if (symbol) symbols.push(symbol);
    }
    scanLine(line, state);
  }
  return symbols;
}

function swiftDeclaration(lines: string[], start: number): ExtractedSymbol | undefined {
  const trimmed = lines[start]!.trim();
  if (SWIFT_SKIPPED_STARTS.test(trimmed)) return undefined;
  const attributeStripped = trimmed.replace(SWIFT_ATTRIBUTE, "").trim();
  const exported = /^(?:public|open)\b/.test(attributeStripped);
  const stripped = attributeStripped.replace(/^(?:public|open|internal|fileprivate|private|final|nonisolated|convenience|override|required|indirect)\s+/, "");
  for (const [pattern, kind] of SWIFT_DECLARATIONS) {
    const match = stripped.match(pattern);
    if (!match) continue;
    const name = match[1]!;
    if (kind === "fn") {
      const signature = declarationText(lines, start, true);
      return { line: start + 1, kind, name, ...signatureFrom(signature, "swift"), exported };
    }
    if (kind === "struct") {
      const signature = declarationText(lines, start, true);
      return {
        line: start + 1,
        kind: /:[\s\S]*\bView\b/.test(signature.split("{")[0] ?? "") ? "view" : "struct",
        name,
        exported,
      };
    }
    return { line: start + 1, kind, name, exported };
  }
  return undefined;
}

function scanLine(line: string, state: ScanState): void {
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (state.quote) {
      if (state.escaped) state.escaped = false;
      else if (char === "\\") state.escaped = true;
      else if (char === state.quote) {
        if (state.triple && line.slice(at, at + 3) === '"""') at += 2;
        state.quote = null;
        state.triple = false;
      }
      continue;
    }
    if (state.blockComment) {
      if (char === "*" && line[at + 1] === "/") {
        state.blockComment = false;
        at++;
      }
      continue;
    }
    if (char === "/" && line[at + 1] === "/") return;
    if (char === "/" && line[at + 1] === "*") {
      state.blockComment = true;
      at++;
      continue;
    }
    if (char === '"' && line.slice(at, at + 3) === '"""') {
      state.quote = '"';
      state.triple = true;
      at += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      state.quote = char;
      continue;
    }
    if (char === "{") state.depth++;
    else if (char === "}" && --state.depth < 0) state.depth = 0;
  }
}

function inString(state: ScanState): boolean {
  return state.quote !== null;
}

function lineSpan(text: string): number {
  return text.split("\n").length;
}
