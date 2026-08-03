# Handoff build — running report

Started 2026-08-04. Written incrementally: the task this feature exists for died
mid-write, so nothing here waits for the end.

## Plan vs code — conflicts found

_(appended as found)_

- `.plans/task-handoff.md` §1 says handoff is "Valid from the states `resume`
  accepts today — `failed`, `blocked`, `cancelled` — plus `needs_input` is out of
  scope for this build." Followed the code: `resumeTask` accepts exactly
  `failed`, `cancelled`, `blocked`, and `handoff` accepts the same three.
- §1 also says "Arguments: `taskId`, `profile` (required …), plus optional
  `model`, `effort`, `scope`", but §4 says "`scope` passed on `resume` replaces
  the grant" — the plan writes the feature as both a new tool and a flag on
  resume in different paragraphs (§105 in Verification says "resumed with
  `profile: B`"). Followed §1 and the task prompt: a dedicated `handoff` tool,
  `resume` untouched.

## Steps

1. Read plan + `tasks.ts`, `store.ts`, `types.ts`, `adapters.ts`, `cli.ts`,
   `mcp-copy.ts`, `events.ts`, `task-protocol.ts`, `public-task.ts` and the
   tests over them. Done.
2. Types: `TaskCompletion.resetsAt`, `TaskAttempt.profileId` / `.sessionId`. Done.
3. `rateLimitResetAt` in `task-protocol.ts` (epoch / countdown / wall clock with
   IANA zone), wired into `interpretWorkerOutcome`. Widened `classifyFailure` to
   read "session limit" / "usage limit" / `rate_limit` as rate limits — the
   incident text classified as `worker_error` before, which is why nothing knew
   the task became resumable later. Done.
4. `src/handoff-brief.ts` — deterministic transform over stored rows. Reads the
   trace through `taskEventView`, the normalizer the app's trace already uses,
   so it stays provider-neutral. Done, 7 unit tests green.
5. Store: `closeAttempt` now records the run's profile and session; new
   `handoffTask` statement (separate from `resumeTask`, which holds profile and
   session steady on purpose). Done.
6. `tasks.handoffTask`, reset capture from `rate_limit_event`, accurate
   `retryAt` on the profile failure. Done.
7. MCP: `handoff` tool, `HANDOFF_DESCRIPTION`, resume description now points at
   it, contract version 20 → 21. Done.

8. Tests: `tests/handoff-brief.test.ts` (7), `tests/handoff.test.ts` (6), plus
   store, task-protocol, public-task and mcp-copy cases, plus one live
   two-worker case in the gated integration file. Docs: `docs/handoff.md`,
   `docs/fields.md` updated. Done.

## Result

`bun test` — 312 pass, 17 skip, 0 fail (329 across 23 files).
`bun run typecheck` — clean.

The 17 skips are `INTER_SANDBOX_INTEGRATION=1` cases: 16 pre-existing plus the
new live handoff case. Worker spawn cannot run in this environment at all —
`sandbox-exec: sandbox_apply: Operation not permitted`, because this session is
itself inside a worker sandbox and sandbox-exec does not nest. Every non-gated
test here is therefore written to prove the logic without a live provider run,
which is the repo's existing convention.

## Notes

- The brief renders tool paths through the trace's own `shortPath`, so long
  paths appear elided (`…/project/src/store.ts`). Left as is: it is the same
  text the app shows, and the written-files section carries full relative paths.
- Reasoning blocks are deliberately excluded from the transcript — largest thing
  in a trace, least load-bearing once the conclusions are carried.
- `TaskAttempt.sessionId` is stored but stripped from `taskView`, so
  `fields: ["attempts"]` shows the previous **profile** and not the previous
  provider session. The plan asks for the session to be preserved on the attempt
  (storage) and the repo promises provider sessions never cross the MCP surface;
  both hold. `HANDOFF_DESCRIPTION` says profile, not session, for that reason.

## Problems noted, not fixed (out of scope)

- `README.md` still lists the tool set without `handoff`. It is outside this
  task's write scope (`src/**`, `tests/**`, `docs/**`, `.plans/**`), so the entry
  could not be added. One bullet is needed after `resume` around L367.
- A handoff to a `claude` profile inherits the task's scope, and a literal file
  path in a write scope is unusable for claude workers (their atomic write needs
  the `.tmp.*` sibling). Pre-existing, applies equally to delegate and resume;
  not touched here.
- `GET /api/state` still ships every task row in full on a 1s poll, so attempts
  now carry two more small fields per prior run. Unchanged sink, noted only.
- There is no HTTP route for handoff (`/api/tasks/:id/resume` has one). Not
  built: nothing asked for it, and the Swift app has no handoff affordance yet.
</content>
</invoke>
