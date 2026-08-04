# Following a task without paying for it

Delegating is cheap. *Following* used to be the expensive part, and it cost two
things on every check:

- **The turn.** `wait` is an MCP call, and a tool call is request/response
  inside the caller's turn. A blocking `wait` owns that turn by construction —
  the caller can do nothing else while it follows.
- **The tokens.** Every poll re-shipped what had not changed. One measured
  `wait` response came back at **276,560 characters** and had to be spilled to a
  file before it could be read. It cost more than the work it was reporting on.

There are two ways to follow a task. Use the first one by default.

## 1. Background the `watch` subcommand — the default

`package.json` declares an `inter` bin, but nothing links it and `make install`
ships an app bundle rather than a CLI, so `inter` is on nobody's PATH until they
link it themselves. Until then the invocation is the entry point directly:

```sh
bun run src/cli.ts watch 8f2c1a94-... --timeout 30m &
```

The rest of this page writes `inter watch` for brevity; substitute
`bun run src/cli.ts watch` unless the bin is linked. `watchCommand()` in
`src/watch.ts` derives whichever of the two applies from `process.argv[1]`, and
both the usage text and the `wait` tool description print it from there — so
neither can name a command that does not run.

A blocked process costs nothing while it sleeps: no tokens, no turn, no
context. Every client Inter serves has a shell, so this needs no client
extension and no research-preview flag. In Claude Code a background command
re-invokes the agent when it exits — so backgrounding `inter watch` *is* the
notification.

It blocks until any named task asks a question, fails, is cancelled, or
completes, and then prints **one line per settled task**:

```
8f2c1a94-... completed — Port the parser
8f2c1a94-... needs_input Which database should the migration target? — Port the parser
8f2c1a94-... failed timeout after 600000ms — Port the parser
8f2c1a94-... completed (archived) — Port the parser
```

The trailing title is what tells a fan-out's lines apart without spending an
`inspect` per id; a task with no title prints the bare id and state, as before.
`(archived)` marks a task that has been archived — it still resolves and still
settles, unlike an id this store has never held, which exits `2` and names the
database file it searched.

That is the entire output. A task still running prints nothing, because silence
is the point.

**Exit codes carry the news on their own**, so a caller that only reads `$?`
still learns whether it was woken by a task or by the clock:

| Code | Meaning |
| --- | --- |
| `0` | At least one task settled; its line is on stdout |
| `1` | The deadline passed with nothing to report |
| `2` | Bad arguments, or an unknown task id (message on stderr) |

Options:

- Several ids follow a whole fan-out at once: `inter watch <id> <id> <id>`.
- `--timeout` (or `-t`) takes `90s`, `30m`, `2h`, or a bare number of
  milliseconds. It defaults to 30 minutes, so a watch can never hang forever.

Where the harness does not re-invoke on exit, redirect the line to a file the
agent can read for near-zero cost — degraded, but never silent:

```sh
inter watch 8f2c1a94-... > /tmp/task.watch 2>&1 &
```

`watch` reads the same SQLite store the broker writes rather than calling the
broker over HTTP, so a caller holding a task id gets an answer even when nothing
is listening on the port. It opens that store as an observer: the broker's
startup duties — profile seeding and interrupted-task recovery — stay with the
broker, because a second process running recovery would fail every task it came
to watch.

## 2. The MCP `wait` — when you genuinely want to block

`wait` is still right when the caller has nothing else to do and wants an answer
inside this turn, or when it wants the event trace rather than just the verdict.
Use `until: "attention"` so it returns the moment a task asks a question or
reaches a terminal state.

It now returns only what **moves**:

```
id, state, updatedAt
```

plus `error`, `question`, `completion`, `costUsd` and `turns` when they are
there to report — and `attemptCount` / `archivedAt`, which are on every task
view. Everything static — profile, model, cwd, prompt preview, title, tldr — is
the same on the tenth poll as on the first, so it comes only when asked for, via
the same `fields` selector every other tool has (see [fields.md](fields.md)).
`fields` **replaces** the default rather than extending it:

```
wait(taskIds: [...], until: "attention", fields: ["output"])
```

returns `{id, state, output}` — which is how to read a finished run without a
second `inspect` call. `output` no longer rides a settled task by default; that
was the bulk of the 276,560 characters.

The events array groups by task instead of stamping `taskId` and `state` onto
every row, and each summary is trimmed to a trace line rather than a transcript:

```json
"events": [
  { "taskId": "8f2c1a94-...", "events": [{ "id": 41, "type": "agent.tool", "at": "...", "summary": "Read src/store.ts" }] }
]
```

`cursor` and `until: "attention"` are unchanged. This changed *what* `wait`
returns, never *when* it returns.
