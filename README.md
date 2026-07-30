# Inter

Global coding-agent switchboard. Inter runs as a macOS menu-bar app, exposes one
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
   counting as open work.
7. Call `cancel` when work is no longer useful, or set `timeoutMs` on `delegate`
   for automatic cancellation.

## What works

- Native SwiftUI menu-bar app with broker health and recent tasks.
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

Add `.inter.toml` at a project's root to constrain automatic routing by task
class. Rules name providers and model patterns, not local profile IDs, so the
file can be committed and shared. Supported route keys are `mechanical`,
`context`, `build`, `reasoning`, and `general`.

```toml
version = 1

[routes.build]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
  { provider = "opencode", model = "opencode-go/*" },
]

[routes.reasoning]
preference = "quality"
allow = [
  { provider = "claude", model = "*" },
  { provider = "codex", model = "*" },
]
```

Each route accepts `allow`, plus optional `preference` (`balanced`, `quality`,
`cost`, or `speed`) and `min_quality` from 1 through 5. A route preview applies
the policy only when its optional `cwd` is supplied; automatic delegation uses
the delegate request's required `cwd`. Missing `.inter.toml` preserves global
routing. An invalid file fails routing instead of silently falling back.

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
workspace roots; the app currently allows the user's home directory so it works
across projects.

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
  attention, completion, or timeout.
- `health`: report broker and MCP contract versions.
- `inspect`: return one task snapshot immediately.
- `tasks`: list concise task summaries with `limit`, `state`, `since`, and
  `profile` filters. Use `inspect` for full prompt and output.
- `reply`: answer `INTER_NEEDS_INPUT: <question>` and return a linked
  continuation task.
- `cancel`: stop a queued or running task and its worker process tree.
- `profiles`: list available accounts and models without exposing secret-like env
  values.

Research notes: [docs/research.md](docs/research.md).
