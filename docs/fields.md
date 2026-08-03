# Response shape (`fields`)

Seven MCP tools (`delegate`, `reply`, `resume`, `handoff`, `cancel`, `archive`, `inspect`)
accept a `fields` selector that controls which parts of the task record come
back in the response. The rule is *small by default*: a real `cancel` response
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
| `cancel` | `[]` | `id`, `state` |
| `archive` | `[]` | `id`, `state`, `archivedAt` |
| `inspect` | everything except `prompt`, `shippedPrompt`, `attempts` | the record minus the three heaviest fields |

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
| `scope` | `scope`, `grantId`, `allowQuestions`, `timeoutMs` | File access granted |
| `prompt` | `prompt` | The caller's original prompt (~8k chars avg, 34k peak) |
| `shippedPrompt` | `shippedPrompt` | Prompt plus injected memories and protocol text (~8k avg, 35k peak) |
| `output` | `output` | The worker's final text |
| `attempts` | `attempts` | Full body of every prior run |
| `completion` | `completion`, `error`, `question` | How the run ended |
| `spend` | `costUsd`, `turns` | Aggregate spend across all attempts |
| `all` | every group | The full record minus `sessionId` |

## Worked examples

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
