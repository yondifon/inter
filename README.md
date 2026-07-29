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
2. After approval, call `delegate` with explicit scope, files, success criteria,
   and checks. Reuse approval while destination and scope stay within the grant.
3. Pass the routed `profile` and `model`, or the user's explicit choice.
4. Keep the returned task ID and event cursor. Call `wait` with `afterCursor`;
   it returns on progress, terminal state, needed input, or timeout. Heartbeats
   report elapsed and silent time and mark 30-second stalls.
5. If input is needed, answer reversible, in-scope implementation details
   directly. Ask the user about product intent, secrets, destructive actions, or
   new authority.
6. Call `reply` with the answer. It returns a linked continuation task; wait on
   that new task ID.

## What works

- Native SwiftUI menu-bar app with broker health and recent tasks.
- Add, edit, enable, disable, and delete any number of CLI profiles.
- Per-profile model, capabilities, and arbitrary environment variables.
- Separate Claude logins through `CLAUDE_CONFIG_DIR` (`.claude-work`,
  `.claude-isern`, or any additional account).
- One-click global MCP install for Codex, Claude Code and every Claude account,
  OpenCode, and Antigravity. Existing config gets a `.bak`.
- Shared Streamable HTTP MCP at `http://127.0.0.1:7331/mcp`.
- Cursor-based progress contract: `delegate` → `wait(afterCursor)` → optional
  `reply`, with 10-second heartbeat and 30-second stall signals.
- Model catalog per account. One profile can run any listed model through a
  per-task `model` override.
- Automatic model routing classifies task depth, rejects underpowered choices
  for deep work, then weighs live catalog price and estimated speed.

## Develop

```bash
bun install
make dev
```

`make dev` launches the Swift app. It starts the Bun broker and stores profiles,
task history, and lifecycle events in `~/.inter/inter.db` using SQLite WAL mode.
An existing `~/.inter/inter.config.json` is imported once.

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

- `delegate`: auto-select a model and start work; explicit profile/model wins.
- `route`: explain the selected model and top candidates without starting work.
- `models`: list models by profile/provider; pass any returned ID to `delegate`.
- `wait`: use `afterCursor` to wake on progress, attention, completion, or timeout.
- `health`: report broker and MCP contract versions.
- `inspect`: return one task snapshot immediately.
- `tasks`: list delegated tasks, newest updated first.
- `reply`: answer `INTER_NEEDS_INPUT: <question>` and return a linked
  continuation task.
- `profiles`: list available accounts and models without exposing secret-like env
  values.

Research notes: [docs/research.md](docs/research.md).
