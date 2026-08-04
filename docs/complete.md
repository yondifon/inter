# `complete`: asserting a completion the worker never attested

`unverified` exists because the worker did not attest to its own completion —
the turn was cut mid-generation, or the model just stopped, and the run that
did the whole job lands in `blocked` with code `unverified` (or `failed` with
the exit-code verdict). The rule that a run must end with an
`INTER_RESULT: completed` marker is correct and unchanged.

`complete` is the correction for the cases where the work *demonstrably
landed* anyway and a human checked it. It moves the task to `completed` on the
caller's word — and it says so on the record, permanently.

## Verified vs asserted

The two must never be confused. A **verified** completion means the worker
itself attested success with the marker. An **asserted** completion means the
worker never did, and a caller vouched for the work instead.

The record keeps both halves:

| Field | Verified completion | Asserted completion |
| --- | --- | --- |
| `state` | `completed` | `completed` |
| `completion.code` | `completed` | the original code, untouched (`unverified`, `worker_error`, …) |
| `completion.blocked` | `false` | the original value, untouched (`true`) |
| `completion.assertedCompletion` | absent | `{ assertedBy, reason, assertedAt, replacedCode }` |

`assertedCompletion` rides with the `completion` group on every surface —
`inspect`, `wait`, `tasks`, the app poll — because a completion view without
it would read an asserted success as a verified one. It is present only when
the completion was asserted.

## Valid states

Accepted from `blocked` and `failed` only: those are the states where the
worker's outcome is unresolved, which is exactly what a caller's check can
resolve.

Rejected:

- `running` — asserting completion of work still in flight is a worse mistake
  than leaving the record wrong; wait for it to settle.
- `completed` — the record is already verified; there is nothing to correct.
- `cancelled` — the cancellation is the caller's own act; resume it or archive
  it instead of overwriting your own record.
- `queued`, `needs_input`, `answered` — neither a dead run nor an unresolved
  outcome.

## Validation

- `assertedBy` — required, non-empty, ≤ 200 characters. Who or what vouched:
  your name, the client, the integration.
- `reason` — required, non-empty, ≤ 500 characters. There are no silent
  overrides.

`replacedCode` is derived from the stored completion, never caller-supplied: a
caller may correct a verdict but not rewrite it. It is absent only when the
row never carried a completion (the broker-restart path).

## Trace

The override emits a `completion_asserted` event with the new state
`completed` and payload `{ assertedBy, reason, replacedCode, previousState }`.
Someone reading the event stream sees the correction and who made it.

## Example

A task built the whole feature, never signed off, and sits in
`blocked`/`unverified` after $5.75 of correct work. The caller checks the diff
and calls:

```
complete(taskId: "…", assertedBy: "alice", reason: "feature verified by hand; 416 tests pass")
```

The task now lists as `completed`, drops out of the unfinished list, and its
record still says `completion.code: "unverified"` with the override naming
who, why, and the code it replaced.
