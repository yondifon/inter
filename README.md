# Inter

Inter is a local broker that delegates bounded tasks to external AI provider
CLIs — Claude Code, Codex, OpenCode, Antigravity, and Pi. You hand it a prompt
and a working directory; it picks a model, spawns a sandboxed worker on a
different account, and returns a task ID the moment dispatch succeeds. The
worker runs independently while you get on with other work. When the task needs
input, hits a question, or finishes, Inter tells you — through a backgrounded
`inter watch` process that sleeps for free and reports the moment anything
settles.

Inter runs on macOS as a menu-bar app with a built-in SQLite store, a local
HTTP+MCP API on `127.0.0.1:7331`, and a unix event socket for push delivery.
It is for developers and coding agents who want to fan out implementation,
research, review, and analysis across providers and accounts without paying
context-window cost for work they are not actively steering.

## Why delegation

A bounded task — implement this module, review that diff, research a question —
can run on an external account with scoped filesystem access. The caller writes
the prompt, approves a data scope, and gets back a task ID. From there the
worker runs unattended; the caller checks in when it settles.

This matters for three reasons:

**Separate accounts, separate limits.** Each provider has session caps and
weekly quotas. Delegating spreads work across accounts so a rate limit on one
does not block the whole session.

**No context tax.** A delegated worker's prompt and output do not consume the
caller's context window. The caller pays a few hundred characters for the task
ID and state — not 80,000 characters of re-shipped prompt every time it checks
in.

**Provider choice per task.** A mechanical rename goes to a cheap fast model;
a concurrency audit goes to a frontier model. Inter routes automatically from
the prompt and the project's `.inter.toml` policy, or the caller names a
profile and model explicitly.

## Quickstart

**Requirements:** Bun, macOS (for the menu-bar app and sandbox). The broker
itself runs anywhere Bun runs, but the app and per-task `sandbox-exec`
confinement are macOS-only.

1. **Clone the repo:**
   ```bash
   git clone https://github.com/yondifon/inter.git
   cd inter
   ```
2. **Install dependencies:**
   ```bash
   bun install
   ```
3. **Build and install the broker and the app:**
   ```bash
   make install
   ```
   This builds the broker binary and the Swift app, copies both into
   `/Applications/Inter.app`, links `inter` onto your PATH, and launches the
   app. Run it as your own user, never with sudo — an app installed as root
   cannot be opened from your session, and the install refuses to run that
   way. If the install says Inter is installed but could not be launched
   (typical over SSH or in a session without a GUI), open Inter from
   Applications and its broker starts with it.
4. **Confirm it is running.** `make install` already checks this and prints
   `install: broker verified`; to check again later:
   ```bash
   curl http://127.0.0.1:7331/health
   ```

### After install

**MCP client config:** The app's **Install MCP** button writes a global MCP
entry for every installed client — Claude Code, Codex, OpenCode, and
Antigravity — pointing at `http://127.0.0.1:7331/mcp`. Existing configs get a
`.bak`. For Claude Code channel support (research preview), add the channel
server entry to your project's `.mcp.json`; see
[docs/channel.md](docs/channel.md).

**First launch** detects which provider CLIs are installed and lets you add,
edit, and enable profiles. No accounts are hardcoded. Each profile stores its
provider, default model, and environment variables; secret-like values
(`KEY`, `TOKEN`, `SECRET`, `PASS`) are masked on every surface.

## Command line

`make install` links the compiled binary onto your PATH as `inter`. It carries
its own runtime, so every command below works with no Bun and no checkout.

| Command | What it does |
| --- | --- |
| `inter` | Print help — what Inter is, the commands, and a first run. |
| `inter serve` | Run the broker. The menu-bar app starts it for you. |
| `inter watch <task-id>...` | Wait for a task; prints one line when it settles. |
| `inter inflight` | List the tasks still running, so you know what a restart interrupts. |
| `inter config [cwd]` | Print the effective config for a directory — profiles, routes, worker rules — and which file each setting came from. |
| `inter version` | Print which build this is. |

## Following a task

A delegated task runs unattended. Following it should cost nothing while it
works. Inter gives you three layers, from cheapest to richest:

**1. Background `inter watch <taskId>`** — the default. A backgrounded process
that connects to the broker's unix event socket at `~/.inter/inter.sock` for
instant push delivery, with a SQLite fallback when the socket is absent. It
sleeps for free, prints lifecycle and error lines as they happen, and exits
when any watched task settles. Exit codes carry the news on their own — 0 means
something settled, 1 means the deadline passed with nothing, 2 means bad input.

In Claude Code, a background command that exits re-invokes the agent — so
`inter watch` *is* the notification.

```sh
inter watch 8f2c1a94-... --timeout 30m &
```

**2. MCP `wait`** — a short deliberate block. Blocks up to 30 seconds and
returns the instant attention is needed. Use `until: "attention"` for a sanity
check right after dispatch, or in a harness with no background shell.

**3. `inspect`** — read one task's full record: output, scope, spend,
completion, and (on request) prompt and attempts.

Read [docs/follow-along.md](docs/follow-along.md) for the full story.

## Tool surface

Every tool is available over MCP (`http://127.0.0.1:7331/mcp`) and the REST API.

| Tool | What it does |
| --- | --- |
| `delegate` | Start scoped work. Auto-routes or takes an explicit profile/model. |
| `route` | Preview model selection without starting work. |
| `wait` | Block briefly for progress or attention. |
| `inspect` | Full record of one task. |
| `tasks` | List tasks by state, time, profile, or fan-out batch. |
| `reply` | Answer a `needs_input` question on the same provider session. |
| `resume` | Retry a failed, cancelled, or blocked task on the same session. |
| `handoff` | Move a dead task to a different profile, keeping the same task ID. |
| `cancel` | Stop a task and its worker process tree. |
| `complete` | Assert completion when work demonstrably landed but the worker never attested it. |
| `archive` | Soft-hide old tasks without deleting history. |
| `memory` | Durable project facts shared across callers and workers. |
| `profiles` | List accounts, models, availability, and usage. |
| `health` | Broker and MCP contract versions. |

Every task-returning tool accepts a `fields` selector that controls the
response payload. Defaults are minimal — `cancel` returns just `id` and
`state` — because the caller already has the data it sent. Read
[docs/fields.md](docs/fields.md) for per-tool defaults and the group table.

## Architecture

```
  MCP client       MCP / HTTP        Inter broker       sandbox-exec       provider CLI
  (Claude,    ─────────────────→    127.0.0.1:7331   ────────────────→     worker
   Codex, …)  ←── task view           Bun/TS           ←── events, text    (subprocess)
                                   │
                           ┌───────┴────────┐
                           │  SQLite (WAL)   │
                           │  ~/.inter/      │
                           │  inter.db       │
                           └───────┬────────┘
                                   │
                           ┌───────┴────────┐
                           │  event socket   │
                           │  ~/.inter/      │
                           │  inter.sock     │
                           └───────┬────────┘
                                   │
                           ┌───────┴────────┐
                           │  Swift app      │
                           │  menu bar       │
                           └────────────────┘
```

- **Broker** (`src/cli.ts`): TypeScript/Bun HTTP server on loopback-only
  `127.0.0.1:7331`, started by `inter serve`. Handles delegation, lifecycle,
  MCP, and REST. Stateless MCP handler — one fresh server per request so
  dynamic profile tools always reflect current settings.
- **Providers**: Claude Code, Codex, OpenCode, Antigravity, and Pi. Each
  spawned as a sandboxed subprocess with per-task read/write scope enforced by
  `sandbox-exec`. Scope is relative to the task's `cwd`; literal file paths stay
  literal, `dir/**` is recursive, `**` grants the whole tree.
- **Event socket** (`src/event-socket.ts`): Unix-domain socket at
  `~/.inter/inter.sock`. Pushes task-event batches to local subscribers on the
  NDJSON protocol (contract EC-001). `inter watch` consumes it for zero-poll
  follow-along; the Swift app and channel can consume it too.
- **Swift app** (`swift/`): Native SwiftUI menu-bar app showing broker health,
  recent tasks with full event traces, and profile management. Polls
  `/api/state` every two seconds for live updates. Content zoom remembered
  across launches. Ships the broker binary inside the app bundle.
- **Claude Code channel** (`src/channel.ts`): Optional stdio MCP server that
  pushes task state changes into a live Claude Code session via
  `notifications/claude/channel`. Accelerator on top of the portable
  watch/wait/inspect hierarchy, not a replacement. Research preview; requires
  `--dangerously-load-development-channels`.

## Configuration

Configuration resolves through three layers, highest first:

1. `<project>/.inter.toml` — the project's own file, resolved from the task's `cwd`
2. `~/.inter.toml` — your personal config
3. Inter's built-in defaults — discovered accounts and the shipped worker rules

A missing file at any layer is normal. A file that fails to parse fails the
read that consulted it, naming the file. `inter config [cwd]` prints the
effective config for a directory and which file each setting came from.

### Routing policy

A `.inter.toml` constrains which provider/model pairs may run in a project.
Rules name providers and models, never local profile IDs. Inter still chooses
between matching local accounts using their availability.

Route names describe the work: `mechanical`, `context`, `build`, `reasoning`,
`general`. Each route has a provider/model `allow` list and optional
`preference` and `min_quality`.

Routes layer like everything else: a project file's `[routes]` table merges
over the user file's, per class. Scalar fields (`preference`, `min_quality`)
override; an `allow` list the project writes replaces the user's whole list,
because allow lists are written best-first and merging two would scramble their
meaning. A class neither file mentions stays unconstrained.

### Profiles

A `[profiles.<id>]` table lets a file take over the profile list and tune
individual profiles:

```toml
[profiles.claude-work]
label = "Work Claude"

[profiles.claude-personal]
enabled = false
```

Two rules carry the semantics:

- **A layer's `[profiles]` table replaces the list it sees**: ids it does not
  mention are disabled in that scope. That is how a project restricts itself to
  work profiles — it names the ones that may run, and everything below that it
  does not name stops being usable there. A disabled profile cannot be
  dispatched to, routed to, or listed in that project.
- **A named id merges field by field onto the same id below it**: a layer
  overrides only the fields it writes, so the user file's `label` and the
  project file's `model` both land. A file may also introduce an id no lower
  layer has; `provider` is required then, and `model` falls back to the
  provider's default.

Profiles you manage in the Inter app stay in the app's own store — the file
layer only reads. The narrowing binds where it matters: `delegate`, `handoff`,
and every routing read resolve profiles against the task's `cwd`, so a project
file's list is what a dispatch into that project sees.

## Docs

| File | What |
| --- | --- |
| [docs/fields.md](docs/fields.md) | Response shape selector — per-tool defaults, group table, worked examples |
| [docs/follow-along.md](docs/follow-along.md) | Following a task without paying for it — watch / wait / inspect |
| [docs/channel.md](docs/channel.md) | Claude Code channel — setup, launch, and limitations |
| [docs/complete.md](docs/complete.md) | Asserting completion when the worker never attested it |
| [docs/handoff.md](docs/handoff.md) | Moving a dead task across profiles |
| [docs/pi.md](docs/pi.md) | Pi provider reference — dispatch, resume, sandbox, and verification |
| [docs/scope.md](docs/scope.md) | Data scope rules — bare dir vs. `/**` vs. `**`, grants, and EPERM gotchas |
| [docs/gotchas.md](docs/gotchas.md) | Failure modes worth knowing before you hit them, and their fixes |

Development notes live in [docs/internal/](docs/internal/).

## License

Inter is licensed under the [GNU Affero General Public License v3.0](LICENSE.md).
You may use, modify, and share it freely. If you modify Inter and offer it to
others over a network, you must publish your modified source under the same
license.

Contact: `yong@malico.me`

See [LICENSE.md](LICENSE.md) for the full terms.

## Status

Early and moving fast. The broker, app, and MCP surface work. The event socket
and `inter watch` are new. The Claude Code channel is a research preview.
Expect rough edges and rapid iteration.
