import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    : profile.provider === "opencode"
    ? opencodeBootstrapRules(workspace)
    : [];
  const metadataRules = ancestorsForRules(workspace, [...scope.read, ...scope.write]).map((path) =>
    `(allow file-read-metadata (literal ${quote(path)}))(allow file-read-data (literal ${quote(path)}))`
  );
  // Workers get TMPDIR=scratchDir, but platform shims like xcrun resolve the
  // user temp dir via confstr and EPERM writing their cache there. Grant the
  // cache names only — opening all of user temp would silently make every
  // task cwd that lives under tmpdir writable.
  const tempCacheRules = [
    `(allow file-write* (regex #"^${escapeRegExp(realpathIfPresent(tmpdir()))}/xcrun_db[^/]*$"))`,
  ];
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
    ...tempCacheRules,
    ...providerRules,
    ...readRules,
    ...writeRules,
  ].join("");
}

// OpenCode finds the project boundary through Git before it loads project
// config. Its Git subprocess must see only the identity files it needs: opening
// all of .git would let a narrow-scope worker reconstruct every committed file.
// When cwd is not a Git root, OpenCode treats it as a global project and probes
// the legacy top-level home config candidates instead.
function opencodeBootstrapRules(workspace: string): string[] {
  const configNames = ["opencode.json", "opencode.jsonc"];
  const paths = configNames.flatMap((name) => [
    resolve(workspace, name),
    resolve(workspace, ".opencode", name),
  ]);
  const gitDir = resolve(workspace, ".git");
  if (existsSync(gitDir)) {
    paths.push(
      gitDir,
      resolve(gitDir, "HEAD"),
      resolve(gitDir, "config"),
      resolve(gitDir, "commondir"),
      resolve(gitDir, "opencode"),
    );
  } else {
    for (const name of configNames) paths.push(resolve(homedir(), name));
  }
  return unique(paths).map((path) => `(allow file-read* (literal ${quote(path)}))`);
}

// Mirrors the seatbelt write rules so the broker can call a refusal before the
// worker's own CLI swallows the EPERM. Temp locations the sandbox always grants
// (worker scratch, system temp) are never flagged.
export function scopeRefusedWrite(
  target: string,
  cwd: string,
  scope: TaskScope,
  scratchDir?: string,
): string | undefined {
  const resolved = resolve(cwd, target);
  const alwaysWritable = [
    "/dev", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders",
    ...(scratchDir ? [scratchDir] : []),
  ];
  if (alwaysWritable.some((base) => resolved === base || within(base, resolved))) return undefined;
  const allowed = scope.write.some((rule) => {
    if (rule === "**") return resolved === cwd || within(cwd, resolved);
    const base = resolve(cwd, rule.replace(/\/\*\*$/, ""));
    return rule.endsWith("/**") ? resolved === base || within(base, resolved) : resolved === base;
  });
  return allowed ? undefined : resolved;
}

function within(base: string, target: string): boolean {
  const child = relative(base, target);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function normalizeRules(rules: string[], cwd: string, kind: string): string[] {
  if (!Array.isArray(rules)) throw new Error(`scope.${kind} must be an array`);
  return unique(rules.flatMap((raw) => {
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
    return expandDirectoryRule(rule.replace(/\/+$/, ""), base);
  }));
}

// Seatbelt's literal rule on a directory grants the directory itself and
// nothing under it, so a bare `pwa` rule EPERMs on every child read — and
// callers almost always mean the subtree. Existing directories expand to
// their recursive form; files and paths that do not exist yet keep literal
// semantics.
function expandDirectoryRule(rule: string, base: string): string[] {
  if (rule === "**" || rule.endsWith("/**")) return [rule];
  if (rule === ".") return ["**"];
  try {
    if (statSync(base).isDirectory()) return [rule, `${rule}/**`];
  } catch {}
  return [rule];
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
    "/opt/homebrew",
    "/private/etc", "/private/var/db", "/private/var/select", "/private/var/run",
    scratchDir,
    dirname(resolve(executable)),
    dirname(realpathIfPresent(executable)),
    resolve(userHome, ".local/bin"),
    resolve(userHome, ".local/share/claude"),
    resolve(userHome, ".bun"),
    ...rustRuntimeReadPaths(userHome),
    ...goRuntimeReadPaths(userHome),
    ...gitRuntimeReadPaths(userHome),
    resolve(userHome, "Library/Keychains"),
    "/Library/Keychains",
  ];
  if (profile.provider === "claude" && typeof process.getuid === "function") {
    const name = `claude-${process.getuid()}`;
    paths.push(resolve("/tmp", name), resolve("/private/tmp", name));
  }
  if (profile.provider === "codex") {
    // Codex walks a global skills root ahead of any task file; without the
    // grant its loader logs an EPERM before the first turn.
    paths.push(resolve(userHome, ".agents"));
  }
  const dataPaths = profileDataPaths(profile);
  for (const path of dataPaths) paths.push(path);
  paths.push(...symlinkTargetReadPaths(dataPaths, userHome));
  return unique(paths.flatMap((path) => [path, realpathIfPresent(path)]));
}

// Profile config dirs are often dotfile-managed: ~/.codex/AGENTS.md may be a
// symlink into ~/.dotfiles, and seatbelt checks the link's target, not the
// link. Grant read on immediate symlink targets that stay inside the user's
// own home or temp — anything further is the CLI's data, not user bootstrap.
function symlinkTargetReadPaths(dataPaths: string[], userHome: string): string[] {
  const targets: string[] = [];
  const tempRoot = realpathIfPresent(tmpdir());
  for (const dir of dataPaths) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const child = join(dir, entry);
        if (!lstatSync(child).isSymbolicLink()) continue;
        const target = realpathSync(child);
        if (within(userHome, target) || within(tempRoot, target)) targets.push(target);
      } catch {}
    }
  }
  return targets;
}

function runtimeWritePaths(profile: Profile, scratchDir: string): string[] {
  const userHome = homedir();
  const paths = [
    "/dev",
    scratchDir,
    ...rustRuntimeWritePaths(userHome),
    ...goRuntimeWritePaths(userHome),
    ...profileDataPaths(profile),
  ];
  if (profile.provider === "claude" && typeof process.getuid === "function") {
    const name = `claude-${process.getuid()}`;
    paths.push(resolve("/tmp", name), resolve("/private/tmp", name));
  }
  return unique(paths.flatMap((path) => [path, realpathIfPresent(path)]));
}

// Git reads its global config before it will run any command, so a worker
// without it gets "fatal: unable to access '~/.gitconfig'" instead of a diff.
// The config is granted rather than suppressed: pointing GIT_CONFIG_GLOBAL at
// /dev/null also strips user.name, aliases, and safe.directory, which breaks
// the ordinary Git work a delegated task is there to do. Only the config files
// are readable — repository contents stay governed by the task scope, and an
// include.path aimed outside that scope is still denied.
function gitRuntimeReadPaths(userHome: string): string[] {
  const xdgConfig = runtimeHome(Bun.env.XDG_CONFIG_HOME, resolve(userHome, ".config"), userHome);
  return [
    ...(Bun.env.GIT_CONFIG_GLOBAL ? [resolve(Bun.env.GIT_CONFIG_GLOBAL)] : []),
    resolve(userHome, ".gitconfig"),
    resolve(xdgConfig, "git"),
  ];
}

function rustRuntimeReadPaths(userHome: string): string[] {
  const cargoHome = runtimeHome(Bun.env.CARGO_HOME, resolve(userHome, ".cargo"), userHome);
  const rustupHome = runtimeHome(Bun.env.RUSTUP_HOME, resolve(userHome, ".rustup"), userHome);
  return [
    resolve(cargoHome, "bin"),
    resolve(cargoHome, "env"),
    resolve(cargoHome, "config"),
    resolve(cargoHome, "config.toml"),
    resolve(cargoHome, "registry"),
    resolve(cargoHome, "git"),
    rustupHome,
  ];
}

function rustRuntimeWritePaths(userHome: string): string[] {
  const cargoHome = runtimeHome(Bun.env.CARGO_HOME, resolve(userHome, ".cargo"), userHome);
  return [
    resolve(cargoHome, "registry"),
    resolve(cargoHome, "git"),
    resolve(cargoHome, ".package-cache"),
    resolve(cargoHome, ".global-cache"),
  ];
}

function goRuntimeReadPaths(userHome: string): string[] {
  const paths = goRuntimePaths(userHome);
  return [paths.root, paths.modules, paths.cache, paths.config];
}

function goRuntimeWritePaths(userHome: string): string[] {
  const paths = goRuntimePaths(userHome);
  return [paths.modules, paths.cache, paths.config];
}

function goRuntimePaths(userHome: string) {
  const goPathValue = Bun.env.GOPATH?.split(":")[0];
  const goPath = runtimeHome(goPathValue, resolve(userHome, "go"), userHome);
  return {
    root: runtimeHome(Bun.env.GOROOT, "/usr/local/go", userHome),
    modules: runtimeHome(Bun.env.GOMODCACHE, resolve(goPath, "pkg/mod"), userHome),
    cache: runtimeHome(Bun.env.GOCACHE, resolve(userHome, "Library/Caches/go-build"), userHome),
    config: resolve(userHome, "Library/Application Support/go"),
  };
}

function runtimeHome(value: string | undefined, fallback: string, userHome: string): string {
  const expanded = value ? expandHome(value, userHome) : fallback;
  return isAbsolute(expanded) ? resolve(expanded) : fallback;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
