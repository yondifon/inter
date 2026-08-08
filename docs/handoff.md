# Cross-profile handoff (`handoff`)

`resume` continues a task **on the same profile, in the same provider session**.
A provider session belongs to one account. When that account is the thing that
stopped answering, the session is unreachable and every turn it spent is
stranded — the only path used to be a fresh `delegate` with a hand-written
prompt.

On 2026-08-03 that cost a real run: three opus/max reviews on `claude-work`, two
killed by `You've hit your session limit · resets 12:40am (America/Chicago)`. One
had spent **dozens of turns and real money**, had read `store.ts`, `events.ts`, `tasks.ts`
and the test suite, and had formed its findings. On disk: nothing — it died
mid-write. Profile `default` sat at 3% session / 8% week the whole time.
Recovery was a full re-dispatch from zero.

The task row was never the problem. It still held the prompt, the attempts, and
the whole event trace. Nothing read them. `handoff` reads them.

## Two routes out of a rate limit

A rate-limited session is paused, not dead. So there are two ways to recover a
task, and the caller should choose knowingly:

| Route | Cost | Fidelity |
| --- | --- | --- |
| Wait for the window, then `resume` | free | lossless — the same session, with all its context |
| `handoff` to another profile now | a second account's quota | a reconstructed brief |

Which is why every `rate_limit` failure now carries **`completion.resetsAt`** —
the ISO time the window clears. It is parsed from whatever the provider said:
an epoch stamp (`Claude AI usage limit reached|1753999200`), a countdown
(`resets in 48m 15s`), or a wall clock with the zone it was printed in
(`resets 12:40am (America/Chicago)`), and failing all three, from the stream's own
`rate_limit_event`. It rides `completion`, so it appears wherever the failure
already does — `wait`, `inspect`, the failed event, and the app's trace. The
same time becomes the profile's `retryAt`, replacing a flat ten-minute guess
that made a five-hour window look retryable.

A session or usage limit now classifies as `rate_limit` rather than
`worker_error`; before, the incident's own wording did not match the rate-limit
pattern at all.

## What `handoff` does

```
handoff(taskId, profile, model?, effort?, scope?)
```

Same Inter task id, same title, same lineage, same attempt history. The
destination profile must differ from the current one — a handoff to the same
profile is a `resume`, and is rejected with that message. Valid from `failed`,
`cancelled` and `blocked` — the dead states. `resume` accepts those too, and
additionally `completed` when an instruction says what to do next; `handoff` has
no such path, because the brief it builds describes a run that died and a
completed run did not. See [resume.md](resume.md).

The new run starts a **fresh provider session** on the new account, seeded with a
brief. `session_id` is cleared on the row and captured again from the new run;
the previous session id and profile are preserved on the `TaskAttempt` they
belong to, so `inspect` with `fields: ["attempts"]` shows both runs and where
each ran.

`model` defaults to the destination profile's own default: the old model id names
a model on the old account. `effort` carries over unless restated.

## The brief

Deterministic — a transform over stored rows, no model in the loop. It is built
from the task row and its event trace, read through the same normalizer the app's
trace uses, so it is provider-neutral.

1. **The in-flight instruction, when the dead run was a resume.** It leads the
   seed as the current job — the original prompt below it is background that may
   already be finished. A first-run failure has none, and the seed starts with
   the original prompt, exactly as before. A queued follow-up (`queue: "add"`)
   that never ran is *not* carried: it was never the work in progress, and the
   queue survives the handoff and feeds it into the handed-off session after a
   clean landing.
2. **The original prompt, verbatim.** The contract the task started with. It is
   never condensed, however large.
3. **Why the previous run ended** — state, completion code, reason, error, the
   reset time, and its final message.
4. **What it left on disk** — every path the trace shows it writing, so the next
   worker reads a half-written file instead of starting it again.
5. **What it said and did**, in one of two tiers:
   - **Verbatim** (default, up to 24,000 characters): the previous worker's
     actual messages and tool calls, in order. This is the point of the feature —
     a review that reached its conclusion at turn 40 carries that conclusion
     across intact.
   - **Digest** (past the cap, ~8,000 characters): a deduplicated tool trace
     plus the **tail** of the assistant messages kept verbatim. Conclusions live
     at the end, so drops come out of the middle and every drop is stated
     (`N earlier messages omitted…`).
6. **A continuation instruction** — continue the current work, do not repeat
   finished work.

Reasoning blocks are left out: the largest thing in a trace and the least
load-bearing once the conclusions are carried. Replies a provider streamed a
chunk at a time (pi, Antigravity) are rejoined into whole messages.

So is everything else that describes the run rather than the work: broker
heartbeats and state transitions, session/step/turn boundaries, thinking and
progress tickers, usage receipts, and CLI hook notifications. The seed carries
only what the next worker needs — the worker's own messages, its tool calls and
their results, and errors — so the size caps spend their budget on work instead
of plumbing.

The brief is the run's `shippedPrompt`, so what the second worker received is
answerable later like any other dispatch. A `handoff_brief` event records the
tier, the size, and how many messages were dropped.

## Scope and consent

Scope grants are keyed to cwd **and** profile, so moving a task to another
account is a grant question, not a mechanical one. It follows what `delegate`
already does:

- **State `scope`** → fresh approval for the destination; it becomes that
  profile's grant on the cwd, and there is nothing to warn about.
- **Omit it** → the task keeps its own scope, never widened, and the response
  carries a warning naming the destination it was not approved for. The warning
  is suppressed when the destination already holds its own grant for that cwd.

## Not built

Automatic failover on `rate_limit`. It spends a second account's quota and
crosses a scope grant without the caller present, so it needs an explicit
opt-in on `delegate` first.

## Complement: write incrementally

Both workers in the incident died mid-document — one large final write that never
landed. Prompts for long deliverables should ask for the file to be created with
its first section and appended to. That is a prompting convention, not code, but
it is what turns a 43-turn loss into a partial recovery, and it makes the brief's
"what it left on disk" section worth reading.
