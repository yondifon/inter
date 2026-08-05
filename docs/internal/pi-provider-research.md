# Adding `pi` as an Inter provider — implementation reference

Researched 2026-08-03 against `@earendil-works/pi-coding-agent` **0.83.0** (+ `[Unreleased]`).
`pi` was **not installed** on the research machine: every claim below comes from published
source or docs, each with a URL. Nothing here was verified by running `pi`.

Repo note: `badlogic/pi-mono` now redirects to `earendil-works/pi`. `raw.githubusercontent.com`
still serves the old path (used for some fetches below); the GitHub *API* only answers under
`earendil-works/pi`. Prefer `earendil-works/pi` in new links.

---

## 1. TL;DR

- **One-shot + JSON: yes.** `pi --mode json "<prompt>"` runs single-shot and writes every session
  event as NDJSON to stdout, starting with a `{"type":"session",...}` header line. No `-p` needed
  (`--mode json` selects the same print-mode code path). ([json.md], [print-mode.ts], [main.ts#L109-L123])
- **Resume: yes, via `--session-id <id>`** ("use exact project session ID, creating it if missing").
  Works non-interactively, no picker, no prompt — but only inside the *same cwd*, and it silently
  starts a **fresh** session (exit 0) if the id isn't found there. ([args.ts], [main.ts#L390-L402])
- **Auto-approve: nothing to approve.** pi has no permission system and no sandbox: `write`/`edit`/
  `bash` execute immediately. There is no approval flag and no prompt to stall on. `--approve/-a`
  and `--no-approve/-na` are about *project trust* (loading `.pi/` settings + extensions), not tool
  execution. ([security.md], [README §Philosophy])
- **Effort: yes, `--thinking <level>`** with values `off|minimal|low|medium|high|xhigh|max` — a
  superset of Inter's ladder, so the mapping is 1:1 identity. ([args.ts#VALID_THINKING_LEVELS])
- **Model listing: yes, `pi --list-models [search]`** — a padded, human-formatted table
  (`provider model context max-out thinking images`), only for providers that have working auth.
  Model ids are `provider/id`, with an optional `:<thinking>` suffix. ([list-models.ts], [args.ts])

---

## 2. Install & identity

| Fact | Value | Source |
|---|---|---|
| npm package | `@earendil-works/pi-coding-agent` (older scope: `@mariozechner/pi`) | [package.json], [README] |
| install | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` or `curl -fsSL https://pi.dev/install.sh \| sh` | [README §Quick Start] |
| binary on PATH | **`pi`** (`"bin": { "pi": "dist/cli.js" }`) | [package.json] |
| version researched | `0.83.0` (2026-07-29) + unreleased entries | [package.json], [CHANGELOG] |
| version flag | `pi --version` / `-v` (format not documented — see Gap 8) | [args.ts] |
| config dir | `~/.pi/agent/` — `settings.json`, `models.json`, `auth.json`, `trust.json`, `keybindings.json`, `AGENTS.md`, `extensions/`, `skills/`, `prompts/`, `themes/`, `npm/`, `git/` | [README §Settings], [security.md] |
| session dir | `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` | [README §Sessions], [session-manager.ts#L473-L484] |
| project config | `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/SYSTEM.md`, … (trust-gated) | [security.md] |

### Auth

Two paths, both usable headlessly once set up:

- **Env var API keys** — pi reads them directly. The full list is printed by `pi --help`
  ([args.ts#printHelp]): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
  `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY`,
  `ZAI_API_KEY`, `MINIMAX_API_KEY`, `OPENCODE_API_KEY`, `NVIDIA_API_KEY`, `FIREWORKS_API_KEY`,
  `TOGETHER_API_KEY`, `BASETEN_API_KEY`, `AI_GATEWAY_API_KEY`, `AZURE_OPENAI_*`,
  `CLOUDFLARE_API_KEY`/`_ACCOUNT_ID`/`_GATEWAY_ID`, `QWEN_TOKEN_PLAN*`, `XIAOMI_*`, `AWS_*`.
  Also `--api-key <key>` overrides env vars ([args.ts]).
- **Subscription OAuth** — interactive `/login` only (Anthropic Pro/Max, ChatGPT Plus/Pro via
  Codex, GitHub Copilot); credentials land in `~/.pi/agent/auth.json` and are refreshed in-process
  ([README §Providers], [CHANGELOG] "stale credentials after another process updates `auth.json`").
  There is **no `pi login` non-interactive subcommand**; `pi auth print-api-key` /
  `pi auth print-bearer-token` only *export* already-configured credentials ([args.ts#printHelp],
  [CHANGELOG] 0.83.0).

**Inter profile `env` worth passing through:** whichever `*_API_KEY` the profile needs, plus
optionally `PI_CODING_AGENT_DIR` (relocate config dir), `PI_CODING_AGENT_SESSION_DIR` (relocate
sessions — see Gap 3), `PI_SKIP_VERSION_CHECK=1` and/or `PI_TELEMETRY=0` to kill startup network
calls, `PI_CACHE_RETENTION=long` for extended prompt caching. `PI_OFFLINE=1`/`--offline` kills
*all* startup network ops including model-catalog refresh ([README §Environment Variables]).
pi itself sets `AI_AGENT=pi` and `PI_CODING_AGENT=true` in child processes.

### Profile discovery (for `src/profile-discovery.ts`)

Follow the existing pattern: executable name `pi`, config path `.pi` (i.e.
`hasExecutable("pi", path) || hasPath(home, ".pi")`). Caveat: a bare `~/.pi` is a weaker signal
than `~/.codex` — pi's own trust logic explicitly says "a bare `.pi` directory does not count"
([security.md]); `~/.pi/agent/settings.json` or `~/.pi/agent/auth.json` is the stronger marker.

---

## 3. One-shot invocation

In the style of `src/adapters.ts` `commandFor()`:

```ts
case "pi":
  // pi has no sandbox and no approval prompts (docs/security.md), so Inter's
  // outer sandbox is the only boundary — nothing to bypass, nothing to stall on.
  // There is no --cd/--cwd flag: pi uses process.cwd(), so the spawn's cwd is
  // the scope root (main.ts: `const cwd = process.cwd()`).
  return [
    "pi", "--mode", "json", "--model", model,
    ...(effort ? ["--thinking", effort] : []),
    "--no-approve",
    prompt,
  ];
```

Line-by-line:

| Token | Why | Source |
|---|---|---|
| `pi` | binary name from `package.json` `bin` | [package.json] |
| `--mode json` | one-shot + NDJSON events on stdout. `resolveAppMode()` maps `--mode json` → app mode `json`, which runs `runPrintMode({mode:"json"})` and exits. `-p` is **not** needed and `-p` is implied anyway whenever stdout/stdin isn't a TTY. | [main.ts#L109-L123], [main.ts#L903-L909], [print-mode.ts] |
| `--model <model>` | model pattern or ID; accepts `provider/id` and an optional `:<thinking>` suffix. Prefer the `provider/id` form — bare ids shared by several providers were ambiguous/mis-resolved before the `[Unreleased]` fix. | [args.ts], [CHANGELOG §Unreleased #7327] |
| `--thinking <effort>` | reasoning level; `off\|minimal\|low\|medium\|high\|xhigh\|max`. Explicit `--thinking` wins over a `:<level>` suffix in `--model`. | [args.ts#VALID_THINKING_LEVELS], [main.ts#L469-L471] |
| `--no-approve` | ignores project-local `.pi/settings.json` and project extensions for this run. pi packages/extensions "run with full system access", so a delegated repo must not be able to inject them. Drop this flag only if a profile deliberately wants repo-local pi config. | [security.md], [README §Pi Packages] |
| `prompt` (trailing positional) | the prompt. `parseArgs` collects non-flag args into `messages`; `buildInitialMessage` takes `messages[0]` as the initial prompt. | [args.ts], [initial-message.ts#L20-L40] |
| *(no cwd flag)* | **there is no `--cd`/`--cwd`/`--dir` flag anywhere in `parseArgs`.** cwd comes from the process. Spawn with `cwd` set. | [args.ts], [main.ts#L534] |
| *(no approval flag)* | pi has no permission gate to bypass; built-in `read/bash/edit/write` just run. | [security.md §No Built-in Sandbox] |

Notes that change the argv you can safely emit:

- **Exactly one positional.** Every extra positional becomes an additional sequential
  `session.prompt()` turn in the same run ([print-mode.ts], [initial-message.ts]). Never pass the
  prompt split across args.
- **A prompt starting with `@` becomes a file argument** (`arg.startsWith("@")` → `fileArgs`), and a
  prompt starting with `-` produces `Unknown option:` / lands in `unknownFlags`. There is **no `--`
  end-of-options separator** — a literal `--` is parsed as an unknown flag with an empty name and
  *swallows the next argument*. See Gap 1 for the mitigation (pipe the prompt on stdin).
- **stdin is merged into the prompt** in print/json mode: `readPipedStdin()` result is prepended to
  `@file` text and `messages[0]`, joined with `""` (no separator) ([main.ts#L818-L831],
  [initial-message.ts#L20-L40]). Piped stdin + `--mode json` keeps JSONL output (fixed in 0.65.1,
  [CHANGELOG]).
- Optional hardening: `--no-extensions`/`-ne`, `--no-skills`/`-ns`, `--no-context-files`/`-nc`
  restrict what gets loaded; `--tools read,grep,find,ls` gives a read-only run; `--name <n>` sets a
  session display name. All from [args.ts]. `grep`, `find`, `ls` are **off by default**
  ([args.ts#printHelp] "read-only, off by default"), so a scope-review run wanting them must pass
  `--tools`.

---

## 4. Resume invocation

**Supported non-interactively — use `--session-id`.**

```ts
case "pi":
  // --session-id reopens the exact project-local session id, so resume is the
  // one-shot argv plus that flag. It must NOT be combined with -c/-r/--session/
  // --fork (main.ts validateSessionIdFlags exits 1), and it only searches
  // sessions recorded for this cwd.
  return [
    "pi", "--mode", "json", "--model", model,
    ...(effort ? ["--thinking", effort] : []),
    "--no-approve",
    "--session-id", sessionId,
    prompt,
  ];
```

Why this flag and not the alternatives:

| Candidate | Verdict | Source |
|---|---|---|
| `--session-id <id>` | **Chosen.** "Use exact project session ID, creating it if missing." Exact match against sessions for the current cwd, then `SessionManager.open(path)`. No picker, no confirmation. | [args.ts#printHelp], [main.ts#L390-L402] |
| `--session <path\|id>` | Works (path, exact id, or id *prefix*), but if the id resolves to a session recorded under a **different cwd** it calls `promptConfirm("Fork this session into current directory?")` — a `readline` question on stdin. Under Inter that stalls or mis-reads. Avoid. | [main.ts#L345-L364], [main.ts#L240-L251] |
| `-c`/`--continue` | "most recent session" for the cwd — not addressable by id, unsafe with concurrent tasks. | [args.ts], [README §Sessions] |
| `-r`/`--resume` | Interactive session picker. Unusable headlessly. | [args.ts], [session-picker.ts] |
| `--fork <path\|id>` | Copies into a *new* session — not a resume. | [README §Branching] |

Id contract: `assertValidSessionId` enforces
`/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/` ([session-manager.ts#L212-L218]). pi's own ids are
uuidv7 ([session-manager.ts#L205-L207]), which satisfies it. Two viable Inter designs:

1. **Read-then-resume (recommended, matches the other four providers):** take `id` from the
   `{"type":"session",...}` header line of run 1, pass it back via `--session-id`.
2. **Inter-assigned id:** generate the id yourself and pass `--session-id` on *both* the first run
   and resumes (`--session-id` creates it if missing; `--no-session --session-id` is explicitly
   supported for cache affinity, [CHANGELOG] 0.80.3 / #6070). Simpler, but diverges from
   `sessionIdFrom()`.

`canResumeSession()` → **true** for `pi`, with two caveats an implementer must handle:

- **Resume must run in the same cwd.** Session lookup is per-cwd. If the id isn't found there, pi
  prints `Warning: No project session found with id '<id>'; creating a new session with that id.`
  to stderr and continues with **empty history, exit 0** ([main.ts#L390-L402]). Silent context
  loss, not an error. Inter should treat that stderr line as a resume failure.
- If the stored session's `cwd` no longer exists, non-interactive runs **exit 1** with
  `MissingSessionCwdError` ([main.ts#L631-L642]) — fails loud, which is fine.

---

## 5. Event stream reference

`--mode json` writes the session header, then one `JSON.stringify(toJsonEvent(event))` line per
session event, to stdout ([print-mode.ts]). The wire type `JsonAgentSessionEvent` is documented as
"Session event shape emitted by the JSON *and* RPC stdout protocols" ([json-event.ts]), so the
event examples in `docs/rpc.md` apply verbatim to `--mode json`. Framing is strict LF-delimited
JSONL — split on `\n` only ([README §RPC Mode], [rpc.md §Framing]).

### Verbatim examples

Session header — first line of the stream ([json.md]):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Typed as ([session-manager.ts#L30-L40]):

```ts
export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}
```

Lifecycle + streaming skeleton ([json.md]):

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

Assistant text chunks ([rpc.md §message_update]):

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

Delta kinds: `text_start|text_delta|text_end|thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|toolcall_end` (`toolcall_end` carries the completed `toolCall` object) ([rpc.md §message_update]).

Tool call start ([rpc.md §tool_execution_*]):

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

Tool progress:

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

Tool result:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Final assistant message payload — the `message` inside `message_end`/`turn_end`
([rpc.md §AssistantMessage]):

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

`stopReason` ∈ `"stop"|"length"|"toolUse"|"error"|"aborted"`; an errored assistant message also
carries `errorMessage` ([rpc.md §AssistantMessage], [print-mode.ts]).

Tool-result message (inside `turn_end.toolResults` / `agent_end.messages`) ([rpc.md §ToolResultMessage]):

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "isError": false,
  "timestamp": 1733234567890
}
```

Run end ([rpc.md §agent_end], [rpc.md §agent_settled]):

```json
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"agent_settled"}
```

`agent_end` is one low-level run; **`agent_settled` is the real terminal event** (no retry,
compaction retry, or queued continuation pending). Other event types Inter may want to surface:
`compaction_start`/`compaction_end` (`reason: "manual"|"threshold"|"overflow"`),
`auto_retry_start`/`auto_retry_end`, `queue_update`, `extension_error`
([rpc.md §Event Types]).

### Inter need → pi event → field path

| Inter need | pi event | Field path | Notes |
|---|---|---|---|
| `sessionIdFrom()` | `type: "session"` (first line) | `event.id` | Header only; no later event repeats it. New branch needed. |
| session cwd (sanity check) | `type: "session"` | `event.cwd` | Confirms the spawn cwd pi actually used. |
| assistant text (streaming) | `type: "message_update"` | `event.assistantMessageEvent.delta` where `.type === "text_delta"` | Deltas only; `partial`/cumulative `message` were removed in `[Unreleased]`. |
| thinking (streaming) | `type: "message_update"` | `assistantMessageEvent.delta` where `.type === "thinking_delta"` | |
| `finalText()` | last `type: "message_end"` with `message.role === "assistant"` | join `message.content[]` blocks where `type === "text"` → `.text` | **Inter's generic `finalText()` fails here**: `message.content` is an array, so the `typeof text === "string"` check falls through to raw. Needs a pi branch (mirror `print-mode.ts`'s text-mode loop). |
| run failed | `message_end` | `message.stopReason === "error" \| "aborted"`, `message.errorMessage` | See Gap 2 — json mode exits 0 regardless. |
| tool call start | `type: "tool_execution_start"` | `toolName`, `args`, `toolCallId` | |
| tool call (from message) | `message_end` / `turn_end` | `message.content[] .type === "toolCall"` → `.name`, `.arguments`, `.id` | |
| tool result | `type: "tool_execution_end"` | `result.content[].text`, `isError`, `toolCallId` | `tool_execution_update.partialResult` is cumulative, not a delta. |
| `writeTargetsFrom()` | `tool_execution_start` / `tool_execution_update` | `toolName` ∈ {`write`,`edit`} → `args.path` | See §"write tools" below — **`args`/`arguments` must be added to the input merge**. |
| usage / cost | `message_end` | `message.usage.{input,output,cacheRead,cacheWrite,cost.total}` | |
| terminal | `type: "agent_settled"` | — | Prefer over `agent_end` (`willRetry` may be true). |

### write tools (`writeTargetsFrom()`)

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` ([args.ts#printHelp]).
There is **no** `str_replace`/`multiedit`/`create_file`.

- `write` params: `path` (string, "Path to the file to write (relative or absolute)") + `content`
  ([write.ts#L15-L16], tool `name: "write"` at [write.ts#L187]).
- `edit` params: `path` + `edits: [{oldText,newText}]` ([edit.ts#L46], [edit.ts#L120-L124], tool
  `name: "edit"` at [edit.ts#L293]).

So the tool **names** (`write`, `edit`) are already in Inter's `WRITE_TOOLS`, and the path key
`path` is already read by `writeTargetsFrom()`. Two changes are required:

1. `writeTargetsFrom()` reads the tool name from `tool_name|toolName|tool|name` — pi's `toolName`
   matches ✔.
2. It reads the input from `input | state.input | tool_input | toolInput` — pi uses **`args`**
   (stream events) and **`arguments`** (`toolCall` content blocks). Both must be added to the merge,
   otherwise pi writes are never flagged.

(`write.ts`/`edit.ts` renderers also accept a `file_path` alias for display, but the declared
schema key is `path` — the model is told `path`.)

---

## 6. Effort mapping

pi: `--thinking <level>`, validated against
`["off","minimal","low","medium","high","xhigh","max"]` ([args.ts#VALID_THINKING_LEVELS]).
Inter's ladder is a strict subset → identity mapping.

| Inter effort | pi `--thinking` | Notes |
|---|---|---|
| `minimal` | `minimal` | |
| `low` | `low` | |
| `medium` | `medium` | |
| `high` | `high` | |
| `xhigh` | `xhigh` | |
| `max` | `max` | Added in **0.80.6** (2026-07-09); "natively supported on GPT-5.6 and adaptive Claude models" ([CHANGELOG] 0.80.6). Older `pi` rejects it with a warning diagnostic, not an error. |
| *(omitted)* | omit the flag | pi then inherits the session/settings level. |
| — | `off` | Unreachable from Inter's ladder. Only way to disable thinking entirely. |

Where the mapping is lossy / uncertain:

- **Per-model clamping is real but undocumented.** `--thinking xhigh` on `openai-codex gpt-5.5` was
  silently downgraded to `high` until a fix ([CHANGELOG] line ~1379). pi also exposes
  `PI_REASONING_LEVEL` as the *"current effective reasoning level"* to bash-tool children
  ([README §Environment Variables]) — i.e. requested ≠ effective. Inter cannot know the effective
  level from the flag alone.
- Invalid values are a **warning diagnostic**, not a failure: `parseArgs` pushes
  `Invalid thinking level "<x>". Valid values: …` and leaves thinking unset ([args.ts]). A typo
  degrades silently.
- Behaviour on a non-reasoning model (`reasoning: false` in the catalog) is **UNKNOWN** — not
  documented; `model-resolver.ts` was not read to the bottom. Assume "ignored", verify before
  relying on it.
- `--model sonnet:high` is an alternative spelling; explicit `--thinking` takes precedence
  ([main.ts#L438-L471]). Use one, not both.

---

## 7. Model discovery

```bash
pi --list-models            # all models with working auth
pi --list-models sonnet     # fuzzy search over "<provider> <id>"
pi update --models          # force a catalog refresh
```

Output is a **human table**, not JSON: a header row then one padded row per model, columns joined by
**two spaces**, each column padded to the widest cell ([list-models.ts]):

```
provider  model  context  max-out  thinking  images
```

Row fields ([list-models.ts]): `provider`, `id`, `contextWindow`, `maxTokens` (both
human-formatted: `200000 → 200K`, `1000000 → 1M`), `reasoning ? "yes" : "no"`,
`input.includes("image") ? "yes" : "no"`. Sorted by provider, then id. Because column widths are
dynamic, parse by splitting on `/\s{2,}/` and skipping the header row — not fixed offsets.

Edge cases:

- Zero models → prints `formatNoModelsAvailableMessage()` (an auth-guidance blob, not a table);
  a search with no hits prints `No models matching "<pattern>"` ([list-models.ts]).
- `models.json` load errors go to **stderr** as `Warning: errors loading models.json: …`
  ([list-models.ts]).
- Only models with configured auth are listed ([CHANGELOG] 0.x "`--list-models [search]` … Only
  lists models with configured API keys").
- `--list-models` short-circuits before print mode and exits ([main.ts#L812-L818]).

Model-id syntax for `--model`: a *pattern or id*, supporting `provider/id` and an optional
`:<thinking>` suffix; globs and fuzzy matching are supported for `--models` cycling
(`anthropic/*`, `*sonnet*`) ([args.ts#printHelp], [README §Model Options]). Default provider is
`google` when nothing is specified ([args.ts#printHelp]). **Use `provider/id`** — bare ids shared
across providers were resolved to the first catalog entry until the `[Unreleased]` fix (#7327).
Custom providers/models come from `~/.pi/agent/models.json` ([README §Providers & Models]).

For `src/models.ts`, the shape mirrors the opencode/antigravity branches: run
`["pi", "--list-models"]`, parse the table, and attach the full effort ladder per model when the
`thinking` column is `yes` (pi's ladder is a CLI-level session flag, like Claude's, not per-model
data) — see `CLAUDE_EFFORTS` in `src/models.ts` for the precedent.

---

## 8. Gaps & risks

1. **Prompt-as-positional is fragile, and there is no `--` separator.** A prompt starting with `@`
   becomes a file arg; one starting with `-` becomes an unknown option; a literal `--` is parsed as
   an unknown flag with an empty name and eats the following argument ([args.ts] final `else if`
   chain). *Resolve:* prefer piping the prompt on **stdin** (print/json mode prepends piped stdin to
   the initial message, and `--mode json` keeps JSONL, [CHANGELOG] 0.65.1 / #2848), or pass no
   positional at all. Test with a prompt starting with `-`, `@`, and `--`.
2. **`--mode json` exits 0 even when the model errored.** `runPrintMode` only sets `exitCode = 1` in
   the `mode === "text"` branch ([print-mode.ts]); in json mode a `stopReason: "error"` assistant
   message is just another event. *Resolve:* have Inter's pi branch detect
   `message_end.message.stopReason ∈ {error,aborted}` (plus `errorMessage`) rather than trusting the
   exit code. Verify against a run with a bad API key.
3. **Sandbox interaction with `~/.pi/agent`.** pi writes sessions to
   `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` and may rewrite `auth.json` on OAuth refresh and
   the model catalog on refresh ([README §Sessions], [CHANGELOG §Unreleased #7319]). If Inter's
   `sandbox-exec` profile doesn't grant those writes, session persistence — and therefore resume —
   breaks, exactly like the `claude` `.tmp.*` sibling case. *Resolve:* grant `~/.pi/agent/**`, or
   point sessions at a task-owned dir via `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` (but note
   `--session-id` lookup then searches *that* dir, so resume must reuse the same value).
4. **Resume degrades silently on cwd mismatch.** `--session-id` with an id not found for the current
   cwd prints a stderr warning and starts a *new* session with that id, exit 0
   ([main.ts#L390-L402]). *Resolve:* pin resume to the original cwd and treat
   `Warning: No project session found with id` on stderr as a failed resume.
5. **`--session` can prompt.** If Inter ever uses `--session <id>` instead of `--session-id`, a
   cross-project id triggers `promptConfirm("Fork this session into current directory?")` over
   `readline` on stdin ([main.ts#L345-L364]). Under Inter that hangs or silently answers "no" from
   an EOF/piped stdin. Don't use `--session`.
6. **Extensions can add flags, tools, and interactive UI.** Extensions may register CLI flags
   ([args.ts#printHelp] "Extensions can register additional flags") and custom tools, and the RPC
   protocol has an "Extension UI Protocol" with `select`/`confirm`/`input` requests
   ([rpc.md §Extension UI Protocol]). Whether a *print/json*-mode run can block on such a request is
   **UNKNOWN** — `bindExtensions` is called with `mode: "json" | "print"` and extensions can branch
   on `ctx.mode` ([print-mode.ts], [CHANGELOG] 0.78.x "`ctx.mode`"), but no doc states what happens
   if an extension asks for input in json mode. *Resolve:* run with `--no-extensions -na` for
   determinism, or read `src/core/extensions/` before allowing user extensions.
7. **Event schema churn is recent and breaking.** `[Unreleased]` removes the cumulative `message`
   field and `assistantMessageEvent.partial` from `message_update` (#7290). `agent_settled` and
   `agent_end.willRetry` are newer additions (0.80.6-era, #6363). A parser written against
   `[Unreleased]` will mis-handle `0.82.x`, and vice versa. *Resolve:* pin a minimum version, and
   read the session header's `version` (currently `3`, `CURRENT_SESSION_VERSION`
   [session-manager.ts#L30]) plus `pi --version` at discovery time.
8. **`pi --version` output format is UNKNOWN.** The flag exists ([args.ts]) but the printing code
   path was not read, so whether it prints `0.83.0` or `pi 0.83.0` is unverified. Matters only if
   Inter gates on version. *Resolve:* run `pi --version` once installed.
9. **`--mode json` header emission depends on `sessionManager.getHeader()` being non-null**
   ([print-mode.ts]). For `--no-session` / in-memory sessions it's unverified whether a header line
   is emitted — which would break `sessionIdFrom()`. Inter shouldn't use `--no-session` (it needs
   resume), but don't add it later without re-checking.
10. **All observations about print/json mode come from source, not from a run.** No `pi` binary was
    available, so no event line in §5 was captured from a live process; every JSON example is quoted
    from the repo's own docs. Before shipping, capture one real `pi --mode json` transcript and
    diff it against §5 — especially the header line, `tool_execution_start.args`, and the last
    `message_end`.
11. **`pi` writes chalk-colored diagnostics to stderr** (warnings, `Unknown option:`,
    auth-guidance blobs) while stdout stays pure JSONL ([main.ts], [list-models.ts]). Inter must
    keep the streams separate; don't merge stderr into the event parser.
12. **No `pi models` subcommand.** Model listing is the `--list-models` *flag* on the main binary,
    and its output is a padded table (Gap: format is presentation code, not a stable API —
    [list-models.ts] recomputes column widths per invocation). A future column change breaks a
    naive parser; split on `/\s{2,}/` and key off the header row.

---

## 9. Sources

Raw source & docs (fetched 2026-08-03):

- README: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
- `package.json`: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/package.json
- `CHANGELOG.md`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md
- `docs/json.md`: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/json.md
- `docs/rpc.md`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
- `docs/security.md`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
- `src/cli/args.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts
- `src/cli/list-models.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/list-models.ts
- `src/cli/initial-message.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/initial-message.ts
- `src/main.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
- `src/modes/print-mode.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/print-mode.ts
- `src/modes/json-event.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/json-event.ts
- `src/core/session-manager.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
- `src/core/tools/write.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/write.ts
- `src/core/tools/edit.ts`: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/edit.ts
- docs directory listing: https://api.github.com/repos/earendil-works/pi/contents/packages/coding-agent/docs
- src listings: https://api.github.com/repos/earendil-works/pi/contents/packages/coding-agent/src{,/cli,/core,/core/tools,/modes}
- npm package page: https://www.npmjs.com/package/@earendil-works/pi-coding-agent

Referenced but **not** read (candidates for a follow-up pass): `docs/usage.md` (canonical CLI
reference the changelog links to), `docs/models.md`, `docs/providers.md`, `docs/settings.md`,
`docs/sessions.md`, `docs/session-format.md`, `docs/containerization.md`, `docs/extensions.md`,
`docs/sdk.md`, `src/core/model-resolver.ts`, `src/modes/rpc/rpc-types.ts`,
`src/core/extensions/`, `packages/ai/src/types.ts`, `packages/agent/src/types.ts`.

[README]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Quick Start]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Providers]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Providers & Models]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Sessions]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Settings]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Philosophy]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Pi Packages]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §RPC Mode]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Model Options]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[README §Environment Variables]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
[package.json]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/package.json
[CHANGELOG]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md
[CHANGELOG §Unreleased #7327]: https://github.com/earendil-works/pi/issues/7327
[CHANGELOG §Unreleased #7319]: https://github.com/earendil-works/pi/issues/7319
[json.md]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/json.md
[rpc.md]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §Framing]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §Event Types]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §message_update]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §tool_execution_*]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §agent_end]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §agent_settled]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §AssistantMessage]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §ToolResultMessage]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[rpc.md §Extension UI Protocol]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
[security.md]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
[security.md §No Built-in Sandbox]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
[args.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts
[args.ts#VALID_THINKING_LEVELS]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts
[args.ts#printHelp]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts
[list-models.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/list-models.ts
[initial-message.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/initial-message.ts
[initial-message.ts#L20-L40]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/initial-message.ts
[session-picker.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/session-picker.ts
[main.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L109-L123]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L240-L251]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L345-L364]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L390-L402]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L438-L471]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L469-L471]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L534]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L631-L642]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L812-L818]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L818-L831]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[main.ts#L903-L909]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/main.ts
[print-mode.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/print-mode.ts
[json-event.ts]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/json-event.ts
[session-manager.ts#L30]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
[session-manager.ts#L30-L40]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
[session-manager.ts#L205-L207]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
[session-manager.ts#L212-L218]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
[session-manager.ts#L473-L484]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/session-manager.ts
[write.ts#L15-L16]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/write.ts
[write.ts#L187]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/write.ts
[edit.ts#L46]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/edit.ts
[edit.ts#L120-L124]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/edit.ts
[edit.ts#L293]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/edit.ts
