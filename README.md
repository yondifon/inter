# Inter

Global coding-agent switchboard. Inter runs as a macOS app with a menu-bar item, exposes one
local MCP endpoint, and delegates bounded work to enabled Claude Code, Codex,
OpenCode, or Antigravity profiles.

## For coding agents

Use Inter instead of an in-context subagent when work is bounded and a worker can
start from a prompt plus `cwd`. It fits isolated implementation, test, research,
and review tasks; parallel opinions; and work that needs a specific provider,
account, or model.

Use an in-context subagent when the worker must inherit conversation context,
the caller's active plan, or other state that would be costly or unsafe to
restate.

Agent flow:

1. Delegation can share the prompt and worker-read project data with an external
   CLI account. If the user has not approved a destination and data scope, call
   `route` without reading file contents, then ask: “Allow Inter to share
   `<scope>` with `<provider>` profile `<label>` for this task?”
2. After approval, call `delegate` with `scope.read` and `scope.write` paths
   relative to `cwd`, plus explicit success criteria and checks. Inter enforces
   literal paths and recursive `directory/**` rules with the macOS process sandbox.
3. Pass the routed `profile` and `model`, or the user's explicit choice.
4. Keep the returned task ID and cursor. Call `wait` with `afterCursor`; it
   returns concise new events and per-task heartbeat progress. Provider system
   noise does not wake it. Heartbeats mark 30-second stalls.
5. If input is needed, answer reversible, in-scope implementation details
   directly. Ask the user about product intent, secrets, destructive actions, or
   new authority.
6. Call `reply` with the answer. It returns a linked continuation task; wait on
   that new task ID. The answered parent links forward to the child and stops
   counting as open work. The continuation resumes the worker's own CLI session
   when the provider supports it, so the worker keeps everything it already
   read and planned; if the session is gone it falls back to a fresh run.
7. Call `cancel` when work is no longer useful, or set `timeoutMs` on `delegate`
   for automatic cancellation.

## What works

- Native SwiftUI app with broker health and recent tasks. Menu-bar item toggles
  the window; the app keeps a Dock icon and appears in ⌘-Tab.
- Content zoom from **View ▸ Zoom In / Zoom Out / Actual Size** (`⌘+`, `⌘-`, `⌘0`),
  85%–200%, remembered across launches. Native controls keep their system size.
- First launch detects locally installed or configured CLIs; no personal profiles
  are hardcoded.
- Add, edit, enable, disable, and delete any number of CLI profiles.
- Per-profile model, capabilities, and arbitrary environment variables.
- Separate Claude logins through `CLAUDE_CONFIG_DIR` (`.claude-work`,
  `.claude-personal`, or any additional account).
- One-click global MCP install for Codex, Claude Code and every Claude account,
  OpenCode, and Antigravity. Existing config gets a `.bak`.
- Shared Streamable HTTP MCP at `http://127.0.0.1:7331/mcp`.
- Cursor-based progress contract: `delegate` → `wait(afterCursor)` → optional
  `reply`, with summarized events, 10-second heartbeat, and 30-second stall signals.
- Enforced per-task read/write scope for worker subprocesses.
- Explicit completed, blocked, failed, cancelled, needs-input, and answered states.
- Model catalog per account. One profile can run any listed model through a
  per-task `model` override.
- Automatic model routing classifies task depth, rejects underpowered choices
  for deep work, then weighs live catalog price and estimated speed.

## Project routing policy

Create `.inter.toml` in the project root:

```bash
touch .inter.toml
```

The file constrains automatic model routing for that project. It can be
committed: rules name providers and models, never a user's local profile IDs.
Inter still chooses between matching local accounts using their availability
status.

Start with this complete example, then remove or edit routes that do not fit the
project:

```toml
version = 1

# Small, predictable edits. Change this to Opus if accuracy matters more than cost.
[routes.mechanical]
preference = "speed"
min_quality = 2
allow = [
  { provider = "claude", model = "haiku" },
  { provider = "codex", model = "*mini*" },
]

# Reading, reviewing, tracing, and investigation.
[routes.context]
preference = "quality"
min_quality = 4
allow = [
  { provider = "claude", model = "sonnet" },
  { provider = "opencode", model = "opencode-go/*" },
]

# Implementation must use the strongest allowed models.
[routes.build]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
  { provider = "opencode", model = "opencode-go/*" },
]

# Architecture, security, migrations, and hard research.
# Codex is allowed here but intentionally omitted from routes.build.
[routes.reasoning]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
  { provider = "codex", model = "*" },
]

# Tasks that do not match another class.
[routes.general]
preference = "balanced"
min_quality = 3
allow = [
  { provider = "claude", model = "*" },
  { provider = "codex", model = "*" },
  { provider = "opencode", model = "*" },
  { provider = "antigravity", model = "*" },
]
```

The example makes implementation accuracy-first, limits OpenCode build/context
work to `opencode-go/*`, and reserves Codex for reasoning and general work.
Routes do not need to contain every provider. Inter considers only installed,
enabled profiles with a model matching the route.

Route names describe the work:

| Route | Used for |
| --- | --- |
| `mechanical` | Renames, formatting, simple generation, and other bounded edits |
| `context` | Reading, tracing, reviewing, auditing, and investigation |
| `build` | Implementation, fixes, debugging, refactors, and tests |
| `reasoning` | Architecture, security, migrations, concurrency, and hard research |
| `general` | Work that does not match another class |

Each route supports:

| Field | Required | Meaning |
| --- | --- | --- |
| `allow` | Yes | Non-empty provider/model allowlist |
| `preference` | No | `balanced`, `quality`, `cost`, or `speed` |
| `min_quality` | No | Quality target `1`–`5`; penalizes lower models |

`allow` is the hard constraint. `preference` and `min_quality` rank the models
that remain. If a route must use one exact model, list only that model in
`allow`.

An `allow` entry has `provider` and `model`. Provider IDs are `claude`, `codex`,
`opencode`, or `antigravity`. Model matching is case-insensitive, uses the full
model ID, and supports `*` as an anchored wildcard:

```toml
allow = [
  { provider = "claude", model = "opus" },          # exact model
  { provider = "opencode", model = "opencode-go/*" }, # one model family
  { provider = "codex", model = "*" },              # every Codex model
]
```

Common variations:

Use Opus even for simple mechanical work:

```toml
[routes.mechanical]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
]
```

Allow only one OpenCode model family for builds:

```toml
[routes.build]
preference = "quality"
allow = [
  { provider = "opencode", model = "opencode-go/*" },
]
```

Make Codex reasoning-only by adding it to `routes.reasoning` and leaving it out
of every other route:

```toml
[routes.reasoning]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
  { provider = "codex", model = "*" },
]
```

Only the route matching the classified task applies. `[routes.general]` is not
a fallback for missing route sections. If `[routes.build]` is absent, build work
uses normal global routing.

Automatic delegation reads `.inter.toml` from its required `cwd`. For a preview,
pass that project path to the `route` tool as `cwd`. Omit `cwd` to preview global
routing. Missing `.inter.toml` preserves global behavior. Invalid syntax,
unknown fields, unsupported routes, empty allowlists, and invalid values fail
with the file path and field instead of silently falling back.

Personal account choice stays local. For example, a rule allowing
`claude`/`opus` can route through `claude-work` when it is available and skip
`claude-me` after an observed billing failure. Use the `status` tool to inspect
the availability evidence before delegating.

## Develop

```bash
bun install
make dev
```

`make dev` launches the Swift app. It starts the Bun broker and stores profiles,
task history, and lifecycle events in `~/.inter/inter.db` using SQLite WAL mode.
Build the app bundle:

```bash
make bundle
open dist/Inter.app
```

Install it:

```bash
make install
```

## Global MCP entries

The app's **Install MCP** action updates:

- Codex: `~/.codex/config.toml`
- Claude Code: `~/.claude.json` and each enabled profile's
  `<CLAUDE_CONFIG_DIR>/.claude.json`
- OpenCode: `~/.config/opencode/opencode.json`
- Antigravity: `~/.gemini/config/mcp_config.json`

The broker binds loopback only. `INTER_ROOTS` limits delegated work to configured
workspace roots and defaults to the user's home directory, so a broker started
inside one project can still delegate into any other repo. Set it to a
colon-separated list to narrow the fence.

## MCP tools

- `delegate`: auto-select a model and start scoped work; explicit profile/model
  wins. Supports `allowQuestions` and `timeoutMs`.
- `route`: explain the selected model and top candidates without starting work;
  pass optional `cwd` to preview that project's `.inter.toml`.
- `models`: list models by profile/provider; pass any returned ID to `delegate`.
- `status`: return normalized profile/model availability, with optional
  `profile`, `model`, `provider`, and `refresh` filters. Each record contains
  `profile`, `provider`, `model`, `state`, `source`, `reason`, and `checkedAt`,
  plus `retryAt` when known. States are `available`, `unavailable`, or
  `unknown`; unknown never implies a usable balance. `refresh: true` bypasses
  cached catalog data using safe catalog/auth checks only. It sends no generation
  prompt, intentionally spends no inference credits, and does not claim an exact
  provider credit balance.
- `wait`: use `afterCursor` to receive meaningful events, heartbeat progress,
  attention, completion, or timeout. A single call blocks at most 110s (idle
  transports get cut beyond that); on timeout, call again with the returned
  cursor. Pass `until: "attention"` to sleep through progress events and wake
  only for `needs_input`, terminal states, or timeout — the right mode for
  long tasks that need no supervision every few seconds.
- `health`: report broker and MCP contract versions.
- `inspect`: return one task snapshot immediately.
- `tasks`: list concise task summaries with `limit`, `state`, `since`, and
  `profile` filters. Use `inspect` for full prompt and output.
- `reply`: answer `INTER_NEEDS_INPUT: <question>` and return a linked
  continuation task that resumes the worker's CLI session (`claude --resume`,
  `codex exec resume`, `opencode run --session`), with a fresh-run fallback.
  A worker that skips the marker but ends on a plain question also lands in
  `needs_input`, so `reply` covers prose asks too.
- `resume`: continue a failed, cancelled, or blocked task in its captured
  provider session, returning a linked continuation task.
- `cancel`: stop a queued or running task and its worker process tree.
- `profiles`: list available accounts and models without exposing secret-like env
  values.

Research notes: [docs/research.md](docs/research.md).
