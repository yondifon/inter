# Data scope (`scope`)

`scope` is what a worker may read and write, enforced by the OS — `sandbox-exec`
on macOS — not by convention. It has two lists, `read` and `write`, each made of
rules resolved relative to the task's `cwd`.

## Writing a rule

| Rule | Grants |
| --- | --- |
| `pwa` (a path that exists and is a directory) | The directory itself and everything under it |
| `pwa` (a path that does not exist yet) | That exact path only — it stays literal |
| `pwa/**` | The directory and everything under it, explicitly |
| `src/tasks.ts` | That one file |
| `**` | The whole working tree, including hidden files and `.git` |

An existing directory named without `/**` still grants its subtree — Inter
expands it before enforcing, because a bare directory rule that granted only
the directory itself would `EPERM` on every file inside it, and callers
naming a directory almost always mean everything in it.

A path that does not exist yet cannot be checked against the filesystem, so it
keeps literal semantics — it grants exactly that path and nothing created
under it. Name planned output directories with an explicit `/**` suffix:
`out/**`, not `out`.

Read rules also cover write; write rules do not cover read on their own — list
a path under `write` and it is implicitly readable, but a path listed only
under `read` cannot be written.

## Grants persist per cwd and profile

Stating `scope` on `delegate` records it as that cwd and profile's grant.
Omitting it reuses the newest grant recorded for the cwd — the caller does not
have to restate scope on every dispatch once it has been approved once.

Only a cwd with **no grant at all** falls back to the whole working tree, and
that task is flagged (`scope_ungranted`) so the fallback is never silent.

Reusing a grant approved for a different profile still runs — approval names a
destination account, not just a folder — but the task carries a
`scope_inherited` warning naming the profile the grant was actually approved
for. State `scope` explicitly to approve the new destination and clear it.

`reply`, `resume`, and `handoff` can each replace a task's scope after fresh
approval; the replacement becomes the cwd's new grant.

## Gotchas

### A narrow read scope starves the worker into EPERM workarounds

A worker that cannot read a file it needs does not fail cleanly — it tries to
work around the missing access (re-deriving the file from other reads, guessing
at contents, retrying under a different name) before giving up. Grant read
access generously; it costs nothing but disk visibility, unlike write access.
Existing paths named in the prompt are added to the read grant automatically,
but paths the worker discovers mid-run are not — if the task needs to explore,
grant the directory it will explore in, not just the files the prompt names.

### A literal file in write scope breaks Claude Code workers

Claude Code's `Write` and `Edit` tools write atomically: they create a
`<target>.tmp.<pid>.<hash>` sibling in the same directory, then rename it over
the target. A write scope naming only the literal file
(`write: ["src/tasks.ts"]`) grants the target but not that sibling, so the
first edit fails:

```
EPERM: operation not permitted, open '.../tasks.ts.tmp.71323.e8012dd9c58b'
```

The task ends `blocked` with `permission_denied`, having written nothing.
Grant the containing directory instead: `write: ["src/**"]`. This is specific
to providers whose editing tools write atomically — OpenCode workers write in
place and are unaffected, which is why the failure can pass unnoticed if all
testing happens on one provider.

### Nonexistent output paths need an explicit `/**`

A path that does not exist when the task is scoped stays literal even if the
worker is expected to create a directory tree under it. If the task will write
`out/report.json` and `out/` does not exist yet, scope `out/**`, not `out`.

### A completion's `suggestedScope` names the exact fix

A task blocked by the sandbox ends with `suggestedScope` on its completion.
Passing that value as `scope` on `resume` grants exactly what was missing,
without guessing at a wider scope than the task needs.
