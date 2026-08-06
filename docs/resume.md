# Continuing a task (`resume`)

`resume` reopens a task's **provider session** — the same account, the same
profile, the same conversation the worker was already having. That session is
the expensive thing: it holds the files the worker read, the structure it
mapped, and why it built what it built. Inter's task row holds none of that.

Two things reach for it.

## Retry a run that died

States `failed`, `cancelled`, `blocked`. `instruction` is optional; without one
the worker is told to continue from where it stopped.

```
resume(taskId)
resume(taskId, instruction: "the sandbox refused swift/Tests — here is the scope")
```

## Follow up on a run that finished

State `completed`, and here `instruction` is **required**.

```
resume(taskId, instruction: "move the state dot to the title's tail")
```

This is the case a fresh `delegate` handles badly. A follow-up usually touches
the same file, the same layout, the same constraints the worker just spent turns
reasoning about — and a new task re-reads all of it, re-derives the same
structure, and still ends up not knowing *why* the code is the way it is. The
session already knows.

A completed task **without** an instruction is rejected:

```
task <id> cannot be resumed without an instruction — it already finished,
so there is nothing to retry; say what to do next in instruction
```

There is no default here worth guessing. Re-entering a finished session with
"continue" spends a turn on a worker rereading its own output.

## The finished run is not overwritten

`resume` reuses the task row, so the row's `output`, `error`, `question` and
`completion` are cleared before the new run starts. They are not lost: the same
`closeAttempt` path that reply, resume and handoff have always used files the
finished run as a `TaskAttempt` first, carrying its output, its completion, the
profile it ran on and its session id.

```
inspect(taskId, fields: ["attempts"])
```

still shows what the earlier run produced. Spend accumulates on the row across
runs, as it does for reply and handoff. The last 10 attempts are kept.

### Why the same task id, and not a child task

A provider session has one owner. Two task rows naming the same `session_id`
would both claim the right to continue it, and Inter already treats a resumed
run landing in an unexpected session as a fault (`resume_session_mismatch`).
`parentTaskId` means fan-out — the sidebar groups a batch by it — so a follow-up
filed there would render as a sibling of a batch it is not part of.

What that costs the reader: the task's state leaves `completed` and comes back
to it, so the list shows one row for work that happened in two passes, and the
first pass's output is one `fields: ["attempts"]` away instead of being the
visible result.

## When the session is gone

A provider can drop a session — expired, evicted, too large. Inter detects the
shape of that failure (the resumed worker exits nonzero having emitted no events
at all), records the provider's own text on a `resume_failed` event, and fails
the task with what the caller can act on instead:

```
the provider could not reopen this task's session — it has expired or been
evicted, so the context it held is gone; delegate a fresh task carrying the
context it needs
```

Inter never silently restarts a failed resume as a fresh session. A fresh worker
would receive the instruction and none of the context it assumes.

## In the app

A completed task's detail header carries **Follow up**, which opens a sheet for
the instruction. It is not offered from the sidebar's context menu: that menu is
the no-argument fast path, and a follow-up cannot exist without an instruction.
