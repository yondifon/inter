// The broker is long-lived and outlives the app that spawned it, so `Bun.env.PATH`
// is a snapshot from whenever it started. A CLI installed after that — or one on a
// PATH entry the launching environment never carried — is invisible to Bun.which,
// spawn falls back to the bare name, and sandbox-exec reports it as
// "execvp() of 'opencode' failed: No such file or directory" even though the
// user's shell finds it. Resolution therefore falls back to the login shell's
// PATH, read on demand so the broker heals without a restart.

const REFRESH_TTL_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 5_000;
const START = "__INTER_PATH__";
const END = "__INTER_END__";

let loginPath: string | undefined;
let refreshedAt = 0;

// PATH for worker lookups and for the worker's own environment: the broker
// snapshot first, so its entries still win on ambiguity, plus any directory the
// login shell knows about that the snapshot missed.
export function workerPath(): string {
  // The worker's own PATH has to be complete before it starts, not merely
  // complete enough to have found the CLI: a script CLI re-resolves its
  // interpreter through `env`, and the broker's snapshot may carry the CLI's
  // directory but not the runtime's. Costs one shell, once.
  if (loginPath === undefined) refreshLoginPath();
  return mergePaths(Bun.env.PATH ?? "", loginPath);
}

// Absolute path, so sandbox-exec execvps a real file and runtimeReadPaths can
// grant the directory holding it. Null when nothing resolves.
export function findWorkerExecutable(command: string): string | null {
  const direct = Bun.which(command, { PATH: workerPath() });
  if (direct) return direct;
  if (!refreshLoginPath()) return null;
  return Bun.which(command, { PATH: workerPath() });
}

// Unresolved commands keep the bare name so the failure surfaces as the CLI's
// own error rather than a broker exception.
export function resolveWorkerExecutable(command: string): string {
  return findWorkerExecutable(command) ?? command;
}

export function resetWorkerPath(): void {
  loginPath = undefined;
  refreshedAt = 0;
}

// Login *and* interactive: PATH edits live in profile files and rc files alike,
// and a shell that sources only one of them misses half the installs. The value
// is fenced by sentinels instead of read raw because rc files print banners, and
// a banner concatenated into PATH breaks every later lookup. Throttled on both
// success and failure — the shell costs roughly a second.
function refreshLoginPath(): boolean {
  const now = Date.now();
  if (now - refreshedAt < REFRESH_TTL_MS) return false;
  refreshedAt = now;
  const result = Bun.spawnSync(
    [Bun.env.SHELL ?? "/bin/zsh", "-lic", `printf '${START}%s${END}' "$PATH"`],
    { timeout: CAPTURE_TIMEOUT_MS, stdout: "pipe", stderr: "ignore", env: Bun.env },
  );
  const captured = result.stdout?.toString() ?? "";
  const start = captured.indexOf(START);
  if (start === -1) return false;
  const end = captured.indexOf(END, start + START.length);
  if (end === -1) return false;
  const value = captured.slice(start + START.length, end);
  if (!value) return false;
  loginPath = value;
  return true;
}

function mergePaths(base: string, extra: string | undefined): string {
  if (!extra) return base;
  const seen = new Set(base.split(":").filter(Boolean));
  const added = extra.split(":").filter((dir) => dir && !seen.has(dir));
  if (!added.length) return base;
  return base ? [base, ...added].join(":") : added.join(":");
}
