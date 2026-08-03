import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Profile, Provider } from "./types";
import { defaultModelFor } from "./provider-defaults";
import { findWorkerExecutable } from "./worker-path";

interface DiscoveryOptions {
  home?: string;
  path?: string;
}

const providers: Array<{
  provider: Provider;
  label: string;
  model: string;
  configPaths: string[];
}> = [
  { provider: "codex", label: "Codex", model: defaultModelFor("codex"), configPaths: [".codex"] },
  {
    provider: "opencode",
    label: "OpenCode",
    model: defaultModelFor("opencode"),
    configPaths: [".config/opencode", ".local/share/opencode"],
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    model: defaultModelFor("antigravity"),
    configPaths: [".gemini"],
  },
];

export function discoverProfiles(options: DiscoveryOptions = {}): Profile[] {
  const home = options.home ?? Bun.env.HOME;
  if (!home) return [];
  const path = options.path;
  const profiles = discoverClaude(home, path);

  for (const item of providers) {
    const executable = item.provider === "antigravity" ? "agy" : item.provider;
    if (!hasExecutable(executable, path) &&
        !item.configPaths.some((configPath) => hasPath(home, configPath))) continue;
    profiles.push(profile(item.provider, item.label, item.model));
  }

  // pi is the one provider discovered by executable alone. Its own trust rules
  // treat a bare `~/.pi` as no signal, and the directory outlives an uninstall,
  // so matching on config would mint a profile that dies at spawn.
  if (hasExecutable("pi", path)) {
    profiles.push(profile("pi", "Pi", defaultModelFor("pi")));
  }
  return profiles;
}

function discoverClaude(home: string, path: string | undefined): Profile[] {
  const profiles: Profile[] = [];
  if (hasExecutable("claude", path) ||
      hasPath(home, ".claude") ||
      hasPath(home, ".claude.json")) {
    profiles.push(profile("claude", "Claude", "sonnet"));
  }

  // One readdir, and isDirectory() answers from the entry type the syscall
  // already returned. Globbing home instead made macOS classify every top-level
  // entry, which reaches into Downloads and Desktop and raises a privacy prompt
  // on each launch.
  let entries: string[] = [];
  try {
    entries = readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude-"))
      .map(({ name }) => name);
  } catch {}
  for (const name of entries) {
    const suffix = name.slice(".claude-".length);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(suffix)) continue;
    profiles.push({
      ...profile(`claude-${suffix}`, `Claude · ${suffix}`, "sonnet", "claude"),
      env: { CLAUDE_CONFIG_DIR: `$HOME/${name}` },
    });
  }
  return profiles;
}

function profile(
  id: string,
  label: string,
  model: string,
  provider: Provider = id as Provider,
): Profile {
  return {
    id,
    label,
    provider,
    model,
    enabled: true,
    env: {},
    capabilities: ["build", "review"],
  };
}

// Discovery runs once, when the profile table is seeded, so a provider missed
// here stays missing. Without an explicit PATH it uses the resolver the worker
// spawn uses, so a CLI the broker's snapshot cannot see is either found here or
// enabled by its config directory alone and left to fail at spawn time.
function hasExecutable(command: string, path: string | undefined): boolean {
  return path === undefined
    ? findWorkerExecutable(command) !== null
    : Bun.which(command, { PATH: path }) !== null;
}

// A literal path needs one stat, not a directory scan. Scanning asked the OS
// about every sibling, protected folders included.
function hasPath(home: string, path: string): boolean {
  try {
    return existsSync(join(home, path));
  } catch {
    return false;
  }
}
