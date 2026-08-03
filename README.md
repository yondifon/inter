# Inter

Global coding-agent switchboard. Inter runs as a macOS app with a menu-bar item, exposes one
local MCP endpoint, and delegates bounded work to enabled Claude Code, Codex,
OpenCode, Antigravity, or Pi profiles.

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
   `<scope>` and any saved Inter memories with `<provider>` profile `<label>`
   for this task?”
2. After approval, call `delegate` with explicit success criteria and checks.
   Scope defaults to the whole folder (`read: ["**"]`, `write: ["**"]`). Pass a
   narrower `scope` when full-folder access was not approved or is not needed.
   Inter enforces literal paths and recursive `directory/**` rules with the
   macOS process sandbox.
3. Pass the routed `profile` and `model`, or the user's explicit choice.
4. Keep the returned task ID and cursor. `delegate` returns immediately and the
   worker continues independently. Call `wait` once with `afterCursor` for a
   quick status poll, then return control to the user. Do not loop in the user's
   turn. A later call returns concise new events and heartbeat progress.
5. If input is needed, answer reversible, in-scope implementation details
   directly. Ask the user about product intent, secrets, destructive actions, or
   new authority.
6. Call `reply` with the answer, or `resume` for a failed, cancelled, or blocked
   task. Keep waiting on the same task ID. Both operations continue the captured
   provider session, so the worker keeps everything it already read and planned.
   If the provider reports a different session ID, Inter fails loudly instead
   of silently starting a fresh conversation.
   Provider session IDs are private implementation data; callers pass only the
   Inter task ID returned by `delegate`.
7. Call `cancel` when work is no longer useful, or set `timeoutMs` on `delegate`
   for automatic cancellation.
8. Call `archive` to hide old task history without deleting it. Restore the same
   task later with `archived: false`; its Inter ID and provider session stay intact.

### Task scope rules

All scope rules are relative to `cwd`. Inter supports literal paths and recursive
directory rules; it does not support general glob syntax.

| Rule | Access granted |
| --- | --- |
| `README.md` | That file only |
| `src/**` | `src` and every descendant |
| `**` | The whole working tree under `cwd` |

`src` is a literal path, not a recursive directory grant. Use `src/**` when the
worker must access files inside it. Patterns such as `src/*.rs` are rejected.

`scope.read: ["**"]` lets the external worker read every file below `cwd`,
including hidden files, `.env` files, and `.git` contents. It does not grant
project-data access to parent or sibling directories, and symlinks cannot be
used to escape `cwd`. Request `**` only when the user explicitly approves
sharing the complete working tree with the selected provider.

Task scope is the project-data boundary, not a list of every path the worker
process can access. Inter separately grants narrow system, provider config,
credential, and temporary paths required to start the selected worker CLI.
Those runtime allowances do not make other project directories readable.

Read and write scope are separate. A write rule is also readable, but a read
rule never permits writes. Include generated paths such as `target/**` or
`dist/**` in `scope.write` when validation creates files there. Use `write:
["**"]` only when the worker truly needs to modify any file in the working tree.

Provider tool permission is separate from file scope. Inter pre-approves Claude
Code's `Bash` tool for headless runs; the macOS sandbox still enforces the task's
read and write rules on every command and child process. Network access is not
currently part of task scope and remains available to worker commands. Narrow
Go and Rust toolchain/module/cache paths are granted as runtime data so builds
and tests can execute without opening the rest of the user's home directory.

Example for a Rust implementation task:

```json
{
  "scope": {
    "read": ["**"],
    "write": ["src/**", "migrations/**", "tests/**", "target/**"]
  }
}
```

`reply` keeps the original scope. `resume` keeps it unless a replacement is
provided. If a task needs broader access, get approval for the expanded data or
write scope, then pass the replacement `scope` to `resume`. The same Inter task
ID and provider session continue. `resume` can also replace `allowQuestions`
and `timeoutMs`.

Project memory:

- Use the `memory` tool to `list`, `get`, `set`, or `remove` durable decisions,
  constraints, and conventions keyed by project `cwd`.
- Delegated workers automatically receive active memories for their `cwd`.
- Pass `expectedVersion` when changing a fact that was read earlier, so a stale
  agent cannot silently overwrite another agent's newer update.
- Do not store secrets or transient task status. Each project is limited to 100
  entries and 64,000 total characters.

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
- Non-blocking progress contract: `delegate` returns immediately, while later
  `wait(afterCursor)` polls return summarized events, 10-second heartbeat, and
  30-second stall signals without holding the caller's turn.
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
`opencode`, `antigravity`, or `pi`. Model matching is case-insensitive, uses the full
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
- `wait`: quick status poll for meaningful events, heartbeat progress,
  attention, or completion. It returns immediately by default and is capped at
  250ms even when an older caller passes a larger `timeoutMs`. Pass the returned
  cursor to a later check. Do not loop in the user's turn; delegated workers keep
  running, so the user can chat or dispatch more work meanwhile. The HTTP task
  events endpoint still supports UI-side long polling on a separate connection.
- `health`: report broker and MCP contract versions.
- `inspect`: return one task snapshot immediately.
- `tasks`: list concise task summaries with `limit`, `state`, `since`, and
  `profile` filters. Archived tasks are hidden by default; pass `archived: "only"`
  or `"include"` to find them. Use `inspect` for full prompt and output.
- `archive`: archive or restore one task by Inter task ID. This is a soft archive;
  prompt, output, events, scope, and provider-session mapping remain intact.
- `reply`: answer a `needs_input` question. The same task re-runs in the
  worker's captured CLI session (`claude --resume`, `codex exec resume`,
  `opencode run --session`) — same task ID, no child task. A worker that skips
  the marker but ends on a plain question also lands in `needs_input`, so
  `reply` covers prose asks too.
- `resume`: continue a failed, cancelled, or blocked task using the same task ID
  and captured provider session.
- `cancel`: stop a queued or running task and its worker process tree.
- `profiles`: list available accounts and models without exposing secret-like env
  values.

Every task-returning tool accepts a `fields` selector to control the response
payload. [Read the `fields` docs](docs/fields.md) for per-tool defaults, the
group → field table, and worked examples. The short version: defaults are
minimal — `cancel` returns just `id` and `state` — because the caller already
has the data it sent. Pass `fields: ["all"]` for the full record.

Research notes: [docs/research.md](docs/research.md).
