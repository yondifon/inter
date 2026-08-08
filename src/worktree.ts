import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Task, TaskWorktree } from "./types";

/**
 * Worktrees live in Inter's own data directory rather than under the project.
 * A checkout inside the repo would show up in every scan, every glob and every
 * later worktree, and one concurrent task would be reading another's tree.
 */
export function worktreesRoot(): string {
  const database = Bun.env.INTER_DB;
  return database
    ? join(dirname(resolve(database)), "worktrees")
    : join(homedir(), ".inter", "worktrees");
}

/**
 * Where a task's project state lives. Scope grants, memories, project config
 * and the context map stay keyed to the repository the caller named; only the
 * run itself moves into the worktree.
 */
export function projectCwd(task: Pick<Task, "cwd" | "worktree">): string {
  return task.worktree?.originCwd ?? task.cwd;
}

/**
 * A checkout of this repo's current HEAD on a branch of the task's own, so
 * several tasks can commit against one repository without sharing an index.
 * The branch outlives the worktree: cleanup removes the directory, never the
 * work.
 */
export async function createTaskWorktree(
  originCwd: string,
  taskId: string,
): Promise<{ worktree: TaskWorktree; cwd: string }> {
  const root = await gitOutput(originCwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new Error(`worktree needs a git repository: ${originCwd} is not inside one`);
  }
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (!head) {
    throw new Error(
      `worktree needs a commit to branch from: ${root} has no commits yet — commit once, then delegate`,
    );
  }
  const path = join(worktreesRoot(), taskId);
  const branch = `task/${taskId}`;
  mkdirSync(worktreesRoot(), { recursive: true });
  const added = await git(root, ["worktree", "add", "-b", branch, path, head]);
  if (!added.ok) {
    throw new Error(`could not create a worktree for this task: ${added.stderr.trim()}`);
  }
  // Both sides are resolved before the subdirectory is measured: git reports a
  // real path, and a caller's cwd under a symlinked root would otherwise
  // measure as an escape and land the run back in the original tree.
  // A subdirectory that nothing tracks has no counterpart in a fresh checkout.
  const cwd = join(path, relative(realpathSync(root), realpathSync(originCwd)));
  mkdirSync(cwd, { recursive: true });
  return { worktree: { originCwd, path, branch }, cwd };
}

/** Idempotent: an origin repo that is gone leaves only a directory to drop. */
export async function removeTaskWorktree(worktree: TaskWorktree): Promise<void> {
  const root = await gitOutput(worktree.originCwd, ["rev-parse", "--show-toplevel"]);
  if (root) {
    await git(root, ["worktree", "remove", "--force", worktree.path]);
    await git(root, ["worktree", "prune"]);
  }
  rmSync(worktree.path, { recursive: true, force: true });
}

/** The git directories a worktree run touches, all of them outside its tree. */
export interface WorktreeGitPaths {
  /** The checkout itself, whose `.git` is a pointer file rather than a directory. */
  root: string;
  /** This worktree's private git directory: its index, HEAD and reflog. */
  gitDir: string;
  /** The origin repository's `.git`, holding the objects and the shared refs. */
  commonDir: string;
  /** The one ref this task may move, relative to the common directory. */
  ref: string;
}

/**
 * Resolves the pointer file, or refuses. A worktree removed by cleanup or by
 * hand is not recreated behind the caller's back: the branch still holds the
 * work, and silently starting a second checkout from today's HEAD would hand
 * the worker a tree that is not the one it left.
 */
export function requireTaskWorktree(task: Pick<Task, "worktree">): WorktreeGitPaths | undefined {
  const worktree = task.worktree;
  if (!worktree) return undefined;
  const marker = join(worktree.path, ".git");
  if (!existsSync(marker)) {
    throw new Error(
      `the git worktree for this task is gone: ${worktree.path} — its work is on branch ${worktree.branch} in ${worktree.originCwd}; delegate a fresh task instead`,
    );
  }
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"));
  if (!pointer) throw new Error(`${marker} is no longer a git worktree pointer`);
  const gitDir = resolve(worktree.path, pointer[1]!.trim());
  const commonFile = join(gitDir, "commondir");
  const commonDir = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
    : dirname(dirname(gitDir));
  return { root: worktree.path, gitDir, commonDir, ref: `refs/heads/${worktree.branch}` };
}

// Awaited rather than spawned synchronously: checking out a large repository
// takes seconds, and the broker serves every other task from the same thread.
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  const run = await git(cwd, args);
  return run.ok ? run.stdout.trim() || undefined : undefined;
}
