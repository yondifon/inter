import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Profile, TaskScope } from "./types";

export const FULL_WORKSPACE_SCOPE: TaskScope = { read: ["**"], write: ["**"] };

export function normalizeTaskScope(scope: TaskScope | undefined, cwd: string): TaskScope {
  const input = scope ?? FULL_WORKSPACE_SCOPE;
  return {
    read: normalizeRules(input.read, cwd, "read"),
    write: normalizeRules(input.write, cwd, "write"),
  };
}

export function sandboxedCommand(
  command: string[],
  cwd: string,
  scope: TaskScope,
  profile: Profile,
  scratchDir: string,
): string[] {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("per-task scope enforcement requires macOS sandbox-exec");
  }
  // Bun.which defaults to the PATH snapshot taken at process start; pass the
  // live value so runtime PATH changes (tests, launchd relaunches) are honored.
  const executable = Bun.which(command[0]!, { PATH: Bun.env.PATH }) ?? command[0]!;
  const resolvedCommand = [executable, ...command.slice(1)];
  return [
    "/usr/bin/sandbox-exec",
    "-p",
    sandboxProfile(cwd, scope, profile, resolvedCommand, scratchDir),
    ...resolvedCommand,
  ];
}

export function sandboxProfile(
  cwd: string,
  scope: TaskScope,
  profile: Profile,
  command: string[],
  scratchDir = "/private/tmp/inter-worker",
): string {
  const workspace = realpathIfPresent(cwd);
  const scratch = realpathIfPresent(scratchDir);
  const readRules = unique([...scope.read, ...scope.write]).map((rule) =>
    fileRule("file-read*", workspace, rule)
  );
  const writeRules = scope.write.map((rule) => fileRule("file-write*", workspace, rule));
  const runtimeReads = runtimeReadPaths(profile, command, scratch).map((path) =>
    `(allow file-read* (literal ${quote(path)}))(allow file-read* (subpath ${quote(path)}))`
  );
  const runtimeWrites = runtimeWritePaths(profile, scratch).map((path) =>
    `(allow file-write* (literal ${quote(path)}))(allow file-write* (subpath ${quote(path)}))`
  );
  const providerRules = profile.provider === "claude"
    ? [
      '(allow file-read* (regex #"^/tmp/claude-[^/]*-cwd(/.*)?$"))',
      '(allow file-read* (regex #"^/private/tmp/claude-[^/]*-cwd(/.*)?$"))',
      '(allow file-write* (regex #"^/tmp/claude-[^/]*-cwd(/.*)?$"))',
      '(allow file-write* (regex #"^/private/tmp/claude-[^/]*-cwd(/.*)?$"))',
    ]
    : [];
  const metadataRules = ancestorsForRules(workspace, [...scope.read, ...scope.write]).map((path) =>
    `(allow file-read-metadata (literal ${quote(path)}))(allow file-read-data (literal ${quote(path)}))`
  );
  return [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process*)",
    "(allow signal)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    ...metadataRules,
    ...runtimeReads,
    ...runtimeWrites,
    ...providerRules,
    ...readRules,
    ...writeRules,
  ].join("");
}

function normalizeRules(rules: string[], cwd: string, kind: string): string[] {
  if (!Array.isArray(rules)) throw new Error(`scope.${kind} must be an array`);
  return unique(rules.map((raw) => {
    const rule = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!rule) throw new Error(`scope.${kind} contains an empty path`);
    if (isAbsolute(rule) || rule === ".." || rule.startsWith("../") || rule.includes("/../")) {
      throw new Error(`scope.${kind} must stay inside cwd: ${raw}`);
    }
    if (rule !== "**" && rule.includes("*") && !rule.endsWith("/**")) {
      throw new Error(`scope.${kind} only supports literal paths and /** suffixes: ${raw}`);
    }
    const base = rule === "**" ? cwd : resolve(cwd, rule.replace(/\/\*\*$/, ""));
    const child = relative(cwd, base);
    if (child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`scope.${kind} must stay inside cwd: ${raw}`);
    }
    assertNoSymlinkEscape(base, cwd, kind);
    return rule.replace(/\/+$/, "");
  }));
}

function assertNoSymlinkEscape(target: string, cwd: string, kind: string): void {
  const workspace = realpathSync(cwd);
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  const actual = realpathSync(existing);
  const child = relative(workspace, actual);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`scope.${kind} resolves outside cwd: ${target}`);
  }
}

function fileRule(operation: string, cwd: string, rule: string): string {
  if (rule === "**") return `(allow ${operation} (subpath ${quote(cwd)}))`;
  const recursive = rule.endsWith("/**");
  const path = resolve(cwd, rule.replace(/\/\*\*$/, ""));
  return `(allow ${operation} (${recursive ? "subpath" : "literal"} ${quote(path)}))`;
}

function runtimeReadPaths(profile: Profile, command: string[], scratchDir: string): string[] {
  const userHome = homedir();
  const executable = Bun.which(command[0]!, { PATH: Bun.env.PATH }) ?? command[0]!;
  const paths = [
    "/System", "/usr", "/bin", "/sbin", "/Library", "/dev",
    "/private/etc", "/private/var/db", "/private/var/select", "/private/var/run",
    scratchDir,
    dirname(resolve(executable)),
    dirname(realpathIfPresent(executable)),
    resolve(userHome, ".local/bin"),
    resolve(userHome, ".local/share/claude"),
    resolve(userHome, ".bun"),
    resolve(userHome, "Library/Keychains"),
    "/Library/Keychains",
  ];
  if (profile.provider === "claude" && typeof process.getuid === "function") {
    const name = `claude-${process.getuid()}`;
    paths.push(resolve("/tmp", name), resolve("/private/tmp", name));
  }
  for (const path of profileDataPaths(profile)) paths.push(path);
  return unique(paths.flatMap((path) => [path, realpathIfPresent(path)]));
}

function runtimeWritePaths(profile: Profile, scratchDir: string): string[] {
  const paths = [
    "/dev",
    scratchDir,
    ...profileDataPaths(profile),
  ];
  if (profile.provider === "claude" && typeof process.getuid === "function") {
    const name = `claude-${process.getuid()}`;
    paths.push(resolve("/tmp", name), resolve("/private/tmp", name));
  }
  return unique(paths.flatMap((path) => [path, realpathIfPresent(path)]));
}

function ancestorsForRules(cwd: string, rules: string[]): string[] {
  const paths = new Set<string>();
  for (const rule of ["", ...rules]) {
    let path = rule === "**" ? cwd : resolve(cwd, rule.replace(/\/\*\*$/, ""));
    while (true) {
      paths.add(path);
      if (path === "/") break;
      path = dirname(path);
    }
  }
  return [...paths];
}

function profileDataPaths(profile: Profile): string[] {
  const userHome = homedir();
  const allowedKeys = profile.provider === "claude" ? new Set(["CLAUDE_CONFIG_DIR"])
    : profile.provider === "codex" ? new Set(["CODEX_HOME"])
    : profile.provider === "opencode" ? new Set(["OPENCODE_CONFIG_DIR"])
    : new Set(["GEMINI_CLI_HOME"]);
  const configured = Object.entries(profile.env)
    .filter(([key]) => allowedKeys.has(key))
    .map(([, value]) => expandHome(value, userHome))
    .filter((value) => isAbsolute(value));
  const defaults = profile.provider === "claude" ? [resolve(userHome, ".claude")]
    : profile.provider === "codex" ? [resolve(userHome, ".codex")]
    : profile.provider === "opencode" ? [
      resolve(userHome, ".opencode"),
      resolve(userHome, ".config/opencode"),
      resolve(userHome, ".local/share/opencode"),
      resolve(userHome, ".local/state/opencode"),
      resolve(userHome, ".cache/opencode"),
    ]
    : [resolve(userHome, ".gemini")];
  return unique([...configured, ...defaults]);
}

function expandHome(value: string, userHome: string): string {
  return value.replaceAll("$HOME", userHome).replace(/^~(?=\/|$)/, userHome);
}

function realpathIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function quote(value: string): string {
  return JSON.stringify(value);
}
