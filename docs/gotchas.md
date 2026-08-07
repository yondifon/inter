# Gotchas

Failure modes that cost real time before someone traced them back to how Inter
actually behaves. Each one names the fix or the workaround.

## A timed-out task is resumable, not dead

Hitting `timeoutMs` fails a task with `code: "timeout"` and kills the worker's
process tree, the same way `cancel` does. The task lands in `cancelled` state,
which is a resumable state: its provider session, if one was already captured,
is still on the row. `resume(taskId)` reopens it like any other cancelled run.

If no session was captured before the timeout fired — the provider never got
far enough to emit one — there is nothing for `resume` to reopen, and the same
"no captured session" error applies as it would for any other run that died
before its first turn. See [resume.md](resume.md) and [cancel.md](cancel.md).

## The installed app can serve a stale MCP contract after a rebuild

The broker checks its own freshness on every `health` call
(`GET /health`, or the `health` MCP tool): it compares the git commit baked
into the running binary against the current commit at the head of the source
tree it was built from, and reports `stale: true` plus `currentSha` and a
`hint` — "a newer build exists in the source tree; rebuild and restart the app
(`make install`)" — when they differ.

That check only sees committed history. It reads `git rev-parse --short HEAD`
in the source tree, so uncommitted edits sitting in a dirty working tree never
make the broker report itself stale — only a new commit does. The app
self-updates from source, so a broken or ahead-of-commit working tree can
still break the *installed* app without `stale` ever turning true. If a
client's calls start behaving unexpectedly right after editing source, check
the diff, not just `health`.

## Requested reasoning effort is not verified against what ran

`delegate` and `route` record *why* a task landed on the effort it did —
`effortSource` (`caller`, `projected`, or `none`) and `effortReason` — on the
task's selection decision, readable back with
`inspect(taskId, fields: ["routing"])`. That record says what Inter asked the
provider for. It does not confirm the provider's CLI honored it.

There is no check that reads the effort a worker actually ran at out of its own
session and compares it to what was requested. If a run's depth looks off for
the effort it was dispatched at, the only way to confirm is to open the
provider's own session file for that task and read the effort it logged there
directly — Inter's record is the request, not a receipt.

## Scope

Bare directory vs. `/**` vs. `**`, why a narrow read scope backfires, and why a
literal file in write scope breaks Claude Code workers specifically — see
[scope.md](scope.md).

## Routing

Naming a profile and model explicitly always runs, even when project policy or
account health would have excluded the pair on the automatic path — the
selection filters run as advice attached to `warnings`, never as a refusal. See
[routing.md](routing.md#three-paths-through-delegate).

## Resume, reply, and handoff all touch the same task id

`reply` answers a `needs_input` question. `resume` retries a dead run
(`failed`, `cancelled`, `blocked`) or follows up on a `completed` one, given an
instruction. `handoff` moves a dead run to a different profile when the
account itself, not the work, is the problem. All three reopen or replace the
same provider conversation under the same task id rather than filing a new
one — a fresh `delegate` re-reads everything the worker already knows. See
[resume.md](resume.md) and [handoff.md](handoff.md).
