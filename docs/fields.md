# Response shape (`fields`)

Ten MCP tools (`delegate`, `reply`, `resume`, `handoff`, `complete`, `cancel`,
`archive`, `inspect`, `wait`, `tasks`) accept a `fields` selector that controls which parts of the
task record come back in the response. The rule is *small by default*: a real `cancel` response
once spent 18,000 characters to say `state: "cancelled"`, and one `shippedPrompt`
peaked at 35,405 characters. The caller already wrote the prompt — it should not
pay to get it back unless it asks.

## Per-tool defaults

Every tool ships a different minimal default. The core — `id` and `state` — is
always present and cannot be removed. `attemptCount` joins it when the task has
prior attempts, and `archivedAt` joins it when the task is archived. `cursor`
(on `delegate`, `reply`, `resume` and `handoff`), `selection` (on `delegate`)
and `warnings` (on `delegate` and `handoff`) sit outside `fields` and are always
present.

| Tool | Default fields | Resulting payload |
| --- | --- | --- |
| `delegate` | `["routing"]` | `id`, `state`, `profileId`, `model`, `effort`, `cursor`, `selection` (auto-routed), `warnings` (when applicable) |
| `reply` | `[]` | `id`, `state`, `cursor` |
| `resume` | `[]` | `id`, `state`, `cursor` |
| `handoff` | `["routing"]` | `id`, `state`, `profileId`, `model`, `effort`, `cursor`, `warnings` (when applicable) |
| `cancel` | `[]` | `id`, `state` — one entry per id when called with an array |
| `complete` | `[]` | `id`, `state` |
| `archive` | `[]` | `id`, `state`, `archivedAt` — one entry per id when called with an array |
| `inspect` | everything except `prompt`, `shippedPrompt`, `attempts` | the record minus the three heaviest fields |
| `wait` | `["completion", "spend"]` plus `updatedAt` | `id`, `state`, `updatedAt`, `completion`, `error`, `question`, `costUsd`, `turns` |
| `tasks` | none (per-row default below) | `id`, `state`, `title`, `profileId`, `model`, `updatedAt`, `costUsd` per row |

`wait` is the one tool called in a loop, so its default is the moving half of a
task and nothing else — see [follow-along.md](follow-along.md). `updatedAt` is
added rather than selected because it is the only member of `context` that
moves and the group is all-or-nothing.

`tasks` lists rows, not one task, so its default row is already this lean
without needing a group — `fields` on it replaces that row shape per listing
call the same way it replaces the default everywhere else.

`archive` and `cancel` accept a single task id or an array. A single id
returns one entry, unchanged; an array returns one entry per id, in input
order. An id that could not be acted on (for example one that does not exist)
comes back as `{id, error}` without failing the rest of the batch.

Archiving a task that is not settled stops it first — the same path as
`cancel` — then archives it, so a live task is never hidden while its worker
runs. Its entry carries `stopped: true` and its state reads `cancelled`, and
the stored cancellation reason names archiving. If the stop fails the task is
not archived. Restoring (`archived: false`) never resumes a task: a restored
task stays cancelled.

## `fields` replaces the default

**Passing `fields` replaces the default rather than extending it.** This is
the most surprising rule in the design. `fields: ["output"]` returns the core
plus the output — *not* the tool's default plus the output.

This means:
- `cancel` with `fields: ["output"]` returns `{id, state, output}` — no routing,
  no spend, just what you asked for.
- `delegate` with `fields: ["output"]` returns `{id, state, output, cursor, selection, warnings}` — the core plus output, plus the non-field keys.
- `inspect` with `fields: ["output"]` returns `{id, state, output}` — not the
  inspect default plus output.

If you want the tool's default *and* extra fields, list everything explicitly.
There is no partial-additive shorthand.

## Group → field table

| Group | Fields | What it costs |
| --- | --- | --- |
| `routing` | `profileId`, `model`, `effort` | Where the task ran |
| `context` | `cwd`, `createdAt`, `updatedAt`, `title`, `tldr`, `parentTaskId` | What the task is and when it moved |
| `label` | `title`, `tldr` | Just enough to recognise which task a row is — the cheap subset of `context` |
| `scope` | `scope`, `grantId`, `allowQuestions`, `timeoutMs` | File access granted |
| `prompt` | `prompt` | The caller's original prompt (~8k chars avg, 34k peak) |
| `shippedPrompt` | `shippedPrompt` | Prompt plus injected memories and protocol text (~8k avg, 35k peak) |
| `output` | `output` | The worker's final text |
| `attempts` | `attempts` | Full body of every prior run |
| `completion` | `completion`, `error`, `question` | How the run ended |
| `spend` | `costUsd`, `turns` | Aggregate spend across all attempts |
| `all` | every group | The full record minus `sessionId` |

## Worked examples

### Checking whether a task already owns this work

Before delegating a new task, list recent ones and see just enough to tell
them apart:

```
tasks(fields: ["label"])
```

Each row returns `{id, state, title, tldr}` (plus `archivedAt` when set) —
enough to recognise a task that already touched the file or feature, so it can
be resumed instead of re-delegated.

### Picking up a dispatched task

You dispatched work, waited, and now want only what it produced:

```
fields: ["output"]
```

Returns `{id, state, output}`. You already know where you sent it and what you
asked it to do.

### Debugging a misbehaving worker

The worker produced the wrong answer and you need to see what it actually
received and what it tried before:

```
fields: ["shippedPrompt", "attempts"]
```

Returns `{id, state, shippedPrompt, attempts, attemptCount}`. `shippedPrompt`
shows the exact text the worker saw (prompt plus injected memories and
protocol); `attempts` shows each prior run's full output.

### Reviewing a finished run

The task completed and you want the result, how it ended, and what it cost:

```
fields: ["output", "completion", "spend"]
```

Returns `{id, state, output, completion, error, question, costUsd, turns}`.

## Why the defaults are small

Measured on the live database (306 tasks):

- `shippedPrompt` averages ~8,000 characters and peaks at 35,405.
- `prompt` peaks at 34,636.
- One real `cancel` response spent 18,000 characters to communicate
  `state: "cancelled"`.
- A worst-case task row runs to 86,000 characters (~21k tokens).

A `delegate` → `wait` → `resume` → `cancel` cycle without `fields` used to
re-ship the prompt and shippedPrompt three times. `fields` makes the caller pay
only for what it actually needs to read.
