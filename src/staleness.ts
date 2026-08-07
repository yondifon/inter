import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILD_STAMP } from "./version";

export type Staleness = {
  stale: boolean;
  currentSha?: string;
  hint?: string;
};

export const REBUILD_HINT = "a newer build exists in the source tree; rebuild and restart the app (make install)";

// The Makefile bakes `git rev-parse --short HEAD` into BUILD_STAMP as
// "<sha>-<time>". Only the sha identifies the code; the time is install
// verification's tiebreaker between two same-version builds.
const SHORT_SHA = /^([0-9a-f]{7,40})(?:-|$)/;

export function stampSha(stamp: string): string | undefined {
  return SHORT_SHA.exec(stamp)?.[1];
}

export function assessStaleness(runningStamp: string, currentSha: string | undefined): Staleness {
  const running = stampSha(runningStamp);
  if (!running || !currentSha || currentSha === running) return { stale: false };
  return { stale: true, currentSha, hint: REBUILD_HINT };
}

function repoPathInPlist(plistPath: string): string | undefined {
  try {
    const text = readFileSync(plistPath, "utf8");
    return /<key>InterRepoPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

// The installed broker runs at <bundle>/Contents/Resources/inter-server; the
// bundle's Info.plist records the source tree it was built from. A compiled
// binary run from a checkout is its own source tree — the .git marker walk.
function sourceRepoPath(execPath: string): string | undefined {
  let dir = dirname(execPath);
  for (;;) {
    const plistPath = join(dir, "Contents", "Info.plist");
    if (existsSync(plistPath)) {
      const repo = repoPathInPlist(plistPath);
      if (repo) return repo;
    }
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function currentShortSha(repo: string): string | undefined {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return undefined;
  }
  if (!proc.success) return undefined;
  const sha = proc.stdout?.toString().trim();
  return sha || undefined;
}

// The health endpoint must never fail on this diagnosis: every failure to
// find or read the source resolves to "not stale" rather than throwing. Under
// `bun run` the stamp is "dev" — the running code is the source, so there is
// no older build to be stale against.
export function computeStaleness(execPath = process.execPath, stamp = BUILD_STAMP): Staleness {
  if (!stampSha(stamp)) return { stale: false };
  const repo = sourceRepoPath(execPath);
  if (!repo) return { stale: false };
  return assessStaleness(stamp, currentShortSha(repo));
}
