import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Callers state scope from memory and regularly forget the paths the prompt
// itself names; the worker then EPERMs on a file the caller clearly intended
// it to have. Prompt-mentioned paths that exist under cwd join the read grant
// automatically. Reads only: a prompt that says "never touch secrets.env"
// must not become a write grant for secrets.env, and within-cwd reads are
// what an ungranted cwd falls back to anyway.
export function promptReadPaths(prompt: string, cwd: string, cap = 50): string[] {
  const found: string[] = [];
  for (const token of prompt.split(/[\s`"'()\[\]{}<>]+/)) {
    if (found.length >= cap) break;
    const candidate = token.replace(/^[.,;:!?]+|[.,;:!?]+$/g, "");
    if (!candidate || candidate.length > 200) continue;
    if (!/^[\w@+.-][\w/@+.~-]*$/.test(candidate)) continue;
    if (candidate.includes("..") || isAbsolute(candidate)) continue;
    if (!candidate.includes("/") && !candidate.includes(".")) continue;
    const inside = insideCwd(candidate, cwd);
    if (!inside) continue;
    try {
      statSync(resolve(cwd, inside));
    } catch {
      continue;
    }
    found.push(inside);
  }
  return [...new Set(found)];
}

// When a run dies on sandbox denials, the events carry the exact paths the
// worker reached for. Recover them so the failed task can hand its caller a
// scope that would have worked instead of making them guess from logs.
// Write-side refusals arrive as the broker's own scope_refusal events;
// everything else denial-shaped counts as a read.
export function deniedScopePaths(
  payloads: string[],
  cwd: string,
  cap = 20,
): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  const push = (list: string[], raw: string) => {
    if (list.length >= cap) return;
    // Real denial messages carry paths; bare words like find's "fts_read"
    // error label are not paths and would only pollute the suggestion.
    if (!raw.includes("/")) return;
    const inside = insideCwd(raw, cwd);
    if (inside && !list.includes(inside)) list.push(inside);
  };
  const patterns: Array<[RegExp, string[]]> = [
    [/([^"'\s]+) is outside the granted write scope/g, writes],
    [/EPERM: operation not permitted, \w+ '([^']+)'/g, reads],
    [/FileSystem\.\w+ \(([^)\s]+)\)/g, reads],
    [/(?:ls|find|cat|stat|grep): ([^:]+): Operation not permitted/g, reads],
  ];
  for (const payload of payloads) {
    for (const [pattern, list] of patterns) {
      for (const match of payload.matchAll(pattern)) push(list, match[1]!);
    }
  }
  return { reads, writes };
}

function insideCwd(path: string, cwd: string): string | undefined {
  const base = resolve(cwd, path);
  const child = relative(cwd, base);
  if (child.startsWith("..") || isAbsolute(child)) return undefined;
  return child.replace(/\/+$/, "");
}
