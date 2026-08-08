# Task worktrees (`worktree`)

`worktree: true` on `delegate` gives the task its own checkout of the
repository at `cwd`, on a branch of its own. The worker runs there, commits
there, and never touches your working tree.

Use it when the work should land as commits, and whenever more than one task
runs against the same repository — two workers sharing one checkout share one
index, and they will overwrite each other.

## What Inter creates

| | |
| --- | --- |
| Checkout | `~/.inter/worktrees/<taskId>`, or beside `INTER_DB` when that is set |
| Branch | `task/<taskId>`, created at dispatch |
| Base | the commit `HEAD` points at when the task is dispatched |

The checkout lives in Inter's data directory, never inside the project: a
checkout under the repo would show up in every scan and every later worktree.
If `cwd` is a subdirectory of the repository, the worker runs in the matching
subdirectory of the checkout.

The repository must have at least one commit. A `cwd` outside a git repository,
or a repository with an unborn `HEAD`, fails the dispatch rather than the run.

## What stays on the original repository

Only the run moves. Scope grants, project memories, `.inter.toml` rules, the
routing policy and the context map all stay keyed to the `cwd` you delegated
against, so a worktree task inherits the same approvals as any other task on
that repository and its results fold back into the same map.

Scope rules are relative, so they mean the same paths in the checkout that they
mean in the repository.

The context map is the exception: it is not shipped to a worktree task and the
map lookup route refuses one. The map describes the project's working tree,
including edits you have not committed, and a worktree task is not in that
tree — a map of it would describe files the worker cannot see. For the same
reason a worktree run's writes are not folded back into the project's map.

## Committing inside the sandbox

A linked worktree holds only a `.git` pointer file — the objects and the branch
live in the origin repository, outside the sandboxed tree. For a worktree task
the sandbox therefore also grants, in the origin repository:

- read on the whole of `.git`;
- create on the object store, and rewrite or delete on nothing in it but the
  temporary files git renames a new object out of;
- write on this worktree's own git directory, on `refs/heads/task/<taskId>`,
  on that ref's reflog, and on the lock files a ref update needs.

That is the whole of it. A worker cannot move or delete a branch of yours, and
cannot touch another task's branch either — the one ref it may write is its
own. It cannot delete or rewrite an existing object, so it cannot destroy the
repository's history, and it cannot rewrite `packed-refs`. Git's background
maintenance also cannot run, which is deliberate: a worker has no business
repacking your repository. Each of these is covered by a test.

**Read exposure is the cost of the option.** Reading the object store is what
makes a commit possible at all, so a worktree task can read everything ever
committed to the repository — `git show HEAD:secrets.env` works regardless of
the task's `read` scope. `worktree: true` widens what leaves the machine.
Scope still governs the working tree; it does not govern history.

## After the task

The checkout stays. Review the branch and merge it, or throw it away:

```
git -C <repo> log task/<taskId>
git -C <repo> merge task/<taskId>
```

`inter cleanup --delete` removes the checkouts of tasks it takes — finished,
archived, and untouched since the retention cutoff. It never deletes a branch,
so the work survives the checkout.

The `worktree-remove` MCP tool deletes a task's checkout on demand, without
waiting for cleanup and without archiving the task. Only a settled task that
ran with `worktree: true` has a checkout to remove; a task that is still
running or waiting on a reply is refused. The branch survives the removal
unless `deleteBranch: true` is passed, which also deletes the `task/<taskId>`
branch — nothing else. Removing a checkout that is already gone reports it as
already gone instead of failing.

`resume`, `reply` and `handoff` all continue in the same checkout. Once it is
gone — cleaned up or removed by the tool — they refuse, naming the branch that
holds the work, rather than starting a second checkout from a `HEAD` that has
since moved.
