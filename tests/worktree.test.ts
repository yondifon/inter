import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { cancelTask, delegate } from "../src/tasks";
import { closeStateStore, stateStore } from "../src/store";
import { settled } from "../src/public-task";
import { runCleanup } from "../src/cleanup";
import { sandboxedCommand } from "../src/task-scope";
import { requireTaskWorktree, worktreesRoot } from "../src/worktree";
import type { Profile, Task } from "../src/types";

const integrationTest = process.env.INTER_SANDBOX_INTEGRATION === "1" ? test : test.skip;
const roots: string[] = [];

afterEach(() => {
  closeStateStore();
  delete process.env.INTER_DB;
  delete process.env.INTER_ROOTS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "fake",
  label: "Fake",
  provider: "antigravity",
  model: "fake",
  enabled: true,
  env: {},
  capabilities: [],
  command: ["/bin/sh", "-c", "exit 0"],
};

// The machine's own git config must not decide whether these tests pass:
// commit signing, hooks and excludes are all outside what is under test.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** A broker root with its database, plus a one-commit repository under it. */
function setup(options: { commit?: boolean; repo?: boolean } = {}): string {
  const { commit = true, repo = true } = options;
  const root = mkdtempSync(join(tmpdir(), "inter-worktree-"));
  roots.push(root);
  process.env.INTER_DB = join(root, "inter.db");
  process.env.INTER_ROOTS = root;
  const cwd = join(root, "project");
  mkdirSync(cwd);
  if (repo) {
    git(cwd, "init", "-b", "main");
    writeFileSync(join(cwd, "tracked.txt"), "one\n");
    if (commit) {
      git(cwd, "add", "tracked.txt");
      git(cwd, "commit", "-m", "first");
    }
  }
  stateStore().saveProfiles([profile]);
  return cwd;
}

/**
 * A worktree task on a repository whose refs are packed and which holds a file
 * outside the task's read scope — the shape every reachability test needs.
 */
async function packedRepo() {
  const cwd = setup();
  writeFileSync(join(cwd, "secret.txt"), "classified\n");
  git(cwd, "add", "secret.txt");
  git(cwd, "commit", "-m", "secret");
  const task = await delegate(profile.id, "work", cwd, undefined, undefined, {
    worktree: true,
    scope: { read: ["tracked.txt"], write: ["tracked.txt"] },
  });
  await settle(task.id);
  git(cwd, "pack-refs", "--all");
  return { task, cwd, head: headOf(cwd, "refs/heads/main"), git: join(cwd, ".git") };
}

function headOf(cwd: string, ref: string): string {
  return Bun.spawnSync(["git", "-C", cwd, "rev-parse", ref], { stdout: "pipe" }).stdout.toString().trim();
}

/** The script a worker would run, under exactly the profile its task gets. */
function inSandbox(task: Task, script: string) {
  const scratch = mkdtempSync(join(tmpdir(), "inter-worktree-scratch-"));
  roots.push(scratch);
  const run = Bun.spawnSync(
    sandboxedCommand(["/bin/sh", "-c", script], task.cwd, task.scope, profile, scratch, requireTaskWorktree(task)),
    {
      cwd: task.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMPDIR: scratch, ...GIT_ENV },
    },
  );
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    // xcrun's own cache is denied on every sandboxed run and says nothing
    // about what git could reach.
    stderr: run.stderr.toString().split("\n").filter((line) => !line.includes("xcrun_db")).join("\n"),
  };
}

async function settle(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = stateStore().getTask(taskId);
    if (task && settled(task.state)) return;
    await Bun.sleep(25);
  }
  throw new Error(`task did not settle: ${taskId}`);
}

describe("worktree tasks", () => {
  test("runs in a checkout of the repository on a branch of its own", async () => {
    const cwd = setup();
    const task = await delegate(profile.id, "work", cwd, undefined, undefined, { worktree: true });
    await settle(task.id);

    expect(task.worktree).toEqual({
      originCwd: cwd,
      path: join(worktreesRoot(), task.id),
      branch: `task/${task.id}`,
    });
    expect(task.cwd).toBe(join(worktreesRoot(), task.id));
    expect(existsSync(join(task.cwd, "tracked.txt"))).toBe(true);
    expect(stateStore().getTask(task.id)?.worktree).toEqual(task.worktree);
    expect(
      Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", `task/${task.id}`]).exitCode,
    ).toBe(0);
  }, 30_000);

  test("keeps the scope grant on the repository, not the checkout", async () => {
    const cwd = setup();
    const task = await delegate(profile.id, "work", cwd, undefined, undefined, {
      worktree: true,
      scope: { read: ["**"], write: ["tracked.txt"] },
    });
    await settle(task.id);

    expect(stateStore().latestScopeGrant(cwd, profile.id)?.scope.write).toEqual(["tracked.txt"]);
    expect(stateStore().latestScopeGrant(task.cwd, profile.id)).toBeUndefined();
  }, 30_000);

  test("runs in the matching subdirectory when cwd is below the repository root", async () => {
    const repo = setup();
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "app.txt"), "app\n");
    git(repo, "add", "packages");
    git(repo, "commit", "-m", "nested");

    const task = await delegate(profile.id, "work", nested, undefined, undefined, { worktree: true });
    await settle(task.id);

    expect(task.cwd).toBe(join(worktreesRoot(), task.id, "packages", "app"));
    expect(existsSync(join(task.cwd, "app.txt"))).toBe(true);
    expect(task.worktree?.originCwd).toBe(nested);
  }, 30_000);

  test("refuses a cwd outside a git repository", async () => {
    const cwd = setup({ repo: false });
    await expect(
      delegate(profile.id, "work", cwd, undefined, undefined, { worktree: true }),
    ).rejects.toThrow(/not inside one/);
  }, 30_000);

  test("refuses a repository with no commits", async () => {
    const cwd = setup({ commit: false });
    await expect(
      delegate(profile.id, "work", cwd, undefined, undefined, { worktree: true }),
    ).rejects.toThrow(/no commits yet/);
  }, 30_000);

  test("refuses to continue once the checkout is gone", () => {
    const worktree = { originCwd: "/tmp/project", path: "/tmp/inter-missing-worktree", branch: "task/x" };
    expect(() => requireTaskWorktree({ worktree })).toThrow(/is gone/);
  });

  test("cleanup removes the checkout and keeps the branch", async () => {
    const cwd = setup();
    const task = await delegate(profile.id, "work", cwd, undefined, undefined, { worktree: true });
    await settle(task.id);
    expect(existsSync(task.cwd)).toBe(true);

    // Cleanup only ever takes a task that finished and was archived.
    await cancelTask(task.id, "done with this");
    const raw = new Database(process.env.INTER_DB!);
    raw.query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", task.id);
    raw.close();
    closeStateStore();

    expect(await runCleanup(["--older-than", "1", "--delete"])).toBe(0);
    expect(existsSync(task.cwd)).toBe(false);
    expect(
      Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", `task/${task.id}`]).exitCode,
    ).toBe(0);
  }, 30_000);

  // The feature is only worth having if a worker can actually commit: the
  // objects and the branch live in the origin repository, outside the tree the
  // sandbox is scoped to.
  integrationTest("a worker commits on its task branch inside the sandbox", async () => {
    const cwd = setup();
    const task = await delegate(profile.id, "work", cwd, undefined, undefined, { worktree: true });
    await settle(task.id);

    const run = inSandbox(task, [
      "set -e",
      "printf 'two\\n' >> tracked.txt",
      "git add tracked.txt",
      "git commit -m 'worker commit'",
    ].join("\n"));
    // Git's background maintenance cannot take its lock, and must not: a
    // worker has no business repacking the repository it was lent. Nothing
    // else in a commit is refused.
    expect(run.stderr.replace(/^warning: unable to unlink .*maintenance\.lock.*$/m, ""))
      .not.toMatch(/Operation not permitted/);
    expect(run.exitCode).toBe(0);

    const head = Bun.spawnSync(["git", "-C", cwd, "log", "-1", "--format=%s", `task/${task.id}`]);
    expect(head.stdout.toString().trim()).toBe("worker commit");
  }, 30_000);

  // The promise the option makes: a worker gets a branch, not the repository.
  // Each of these was reachable before the write rules were narrowed to the
  // one ref and the object store's own temp files.
  describe("what a worker still cannot reach", () => {
    integrationTest("cannot move a branch of the user's own", async () => {
      const { task, cwd, head } = await packedRepo();
      const run = inSandbox(task, `git update-ref refs/heads/main ${head}`);

      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toMatch(/refs\/heads\/main\.lock.*Operation not permitted/);
      expect(headOf(cwd, "refs/heads/main")).toBe(head);
    }, 30_000);

    integrationTest("cannot move another task's branch", async () => {
      const { task, cwd, head } = await packedRepo();
      const other = await delegate(profile.id, "other", cwd, undefined, undefined, { worktree: true });
      await settle(other.id);
      const ref = `refs/heads/${other.worktree!.branch}`;
      const run = inSandbox(task, `git update-ref ${ref} ${head}`);

      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toMatch(/\.lock.*Operation not permitted/);
    }, 30_000);

    integrationTest("cannot delete the object store it commits into", async () => {
      const { task, git: gitDir } = await packedRepo();
      const run = inSandbox(task, `rm -rf ${gitDir}/objects`);

      expect(run.exitCode).not.toBe(0);
      expect(existsSync(join(gitDir, "objects"))).toBe(true);
    }, 30_000);

    integrationTest("cannot rewrite packed-refs", async () => {
      const { task, git: gitDir } = await packedRepo();
      const before = readFileSync(join(gitDir, "packed-refs"), "utf8");
      const run = inSandbox(task, `: > ${gitDir}/packed-refs`);

      expect(run.exitCode).not.toBe(0);
      expect(readFileSync(join(gitDir, "packed-refs"), "utf8")).toBe(before);
    }, 30_000);

    // Not a hole — the disclosed cost of the option. A commit is impossible
    // without reading the object store, and the object store is the history.
    integrationTest("can read repository history outside its read scope", async () => {
      const { task } = await packedRepo();
      const run = inSandbox(task, "git show HEAD:secret.txt");

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("classified");
    }, 30_000);
  });
});
