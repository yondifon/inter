import type { Profile, Provider } from "./types";

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
  { provider: "codex", label: "Codex", model: "gpt-5", configPaths: [".codex"] },
  {
    provider: "opencode",
    label: "OpenCode",
    model: "opencode/big-pickle",
    configPaths: [".config/opencode", ".local/share/opencode"],
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    model: "gemini-2.5-pro",
    configPaths: [".gemini"],
  },
];

export function discoverProfiles(options: DiscoveryOptions = {}): Profile[] {
  const home = options.home ?? Bun.env.HOME;
  if (!home) return [];
  const path = options.path ?? Bun.env.PATH ?? "";
  const profiles = discoverClaude(home, path);

  for (const item of providers) {
    if (!hasExecutable(item.provider, path) &&
        !item.configPaths.some((configPath) => hasPath(home, configPath))) continue;
    profiles.push(profile(item.provider, item.label, item.model));
  }
  return profiles;
}

function discoverClaude(home: string, path: string): Profile[] {
  const profiles: Profile[] = [];
  if (hasExecutable("claude", path) ||
      hasPath(home, ".claude") ||
      hasPath(home, ".claude.json")) {
    profiles.push(profile("claude", "Claude", "sonnet"));
  }

  let entries: string[] = [];
  try {
    entries = [...new Bun.Glob(".claude-*/").scanSync({
      cwd: home,
      dot: true,
      onlyFiles: false,
    })];
  } catch {}
  for (const entry of entries) {
    const name = entry.replace(/\/$/, "");
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

function hasExecutable(command: string, path: string): boolean {
  return Bun.which(command, { PATH: path }) !== null;
}

function hasPath(home: string, path: string): boolean {
  try {
    return !new Bun.Glob(path).scanSync({
      cwd: home,
      dot: true,
      onlyFiles: false,
    }).next().done;
  } catch {
    return false;
  }
}
