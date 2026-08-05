# Pushing Inter Task Events into a Live Agent Session

## TL;DR

- **Ships today, Claude Code only.** `notifications/claude/channel` (a stdio MCP server declaring `capabilities.experimental['claude/channel']`) is real, unchanged in contract shape from `docs/channel.md`, and still gated behind `--dangerously-load-development-channels server:<name>` for a non-allowlisted server like Inter's. Confirmed live in Claude Code v2.1.220 (installed here); the flag family (`--channels` / `--dangerously-load-development-channels`) shipped at v2.1.80 and is still labeled "research preview" -- no later CHANGELOG entry graduates it.
- **No supersession mechanism exists, anywhere in the contract.** Events are append-only: queued into the session, delivered as one `<channel>` tag per notification, batched only when Claude is mid-turn. The one "message editing" feature in the whole channel ecosystem (fakechat's `edit_message` tool) edits Claude's own **outbound** replies on the far-side chat platform -- the opposite direction from superseding an **inbound** event Claude already saw. "Clear the UI after each message" is not achievable via any documented Claude Code mechanism today.
- **The MCP spec is narrowing generic push, not widening it.** The 2026-07-28 revision (current; previous was 2025-11-25 -- there is no 2026-03-26 revision) makes `notifications/message` strictly request-scoped (tied to the response stream of the request it answers) and moves the tasks primitive into a poll-only extension. Neither closes the portability gap, and current CLIs (per Inter's own broker comment) cap out at 2025-11-25 anyway.
- **codex still routes `notifications/message` away from the model** -- three feature requests (#15299, #17543, #18056) remain open, last activity June 2026. codex's hooks are reactive to its own turn lifecycle only, not an external-injection surface.
- **opencode has a real alternative Claude Code doesn't:** `POST /session/:id/prompt_async` on its local HTTP server injects a new message into a running session, no MCP extension required. Documented, not inferred. This is the one genuinely new, portable-enough finding in this research.
- **antigravity has public docs now** (antigravity.google/docs) with MCP support, but its hooks are lifecycle-reactive only (`PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop`) -- same shape as codex, no push-into-session surface.
- **channel.ts should not force-fit the event socket's bounded model.** The socket requires an explicit, pre-validated `watch` id list and auto-closes once every watched id settles -- the opposite of channel.ts's actual need (discover new tasks with no prior ids, run forever). Recommended: a hybrid -- cheap periodic id/state discovery poll, plus an event-socket subscription over the currently-tracked non-settled set, reconnected whenever that set changes.
- **pi is the strongest adapter target of all five clients.** A pi extension (a TypeScript file in `~/.pi/agent/extensions/`) gets `pi.sendUserMessage(content, { deliverAs: "steer" | "followUp" | "nextTurn", triggerTurn })` -- a real user-role message into the live session, deliverable mid-stream ("steer"), after the run ("followUp"), and able to wake an idle agent (`triggerTurn: true`). And pi has the supersession no one else has: `ctx.ui.setWidget("inter", [...lines])` renders a named, overwritable widget -- each new event can replace the last one's display. External integrations (file watchers, webhooks) are a documented intended use. pi-coding-agent 0.83.0, repo HEAD 588915e (2026-08-04).

## Question

How can Inter push task events into a live agent session as individual, per-event, in-session messages the model actually sees -- across Claude Code, codex, opencode, and antigravity -- and what should `src/channel.ts` do about the new unix-domain event socket (`src/event-socket.ts`)?

## Findings
### Q1 -- claude/channel contract, current state

#### The flag family is `--channels` (allowlisted plugins) and `--dangerously-load-development-channels` (unlisted/custom servers) -- both still exist, both still "research preview"
`--channels` was added at v2.1.80: *"Added `--channels` (research preview) -- allow MCP servers to push messages into your session."* It was iterated through v2.1.81 (permission relay), v2.1.83 (bug fixes, disables `AskUserQuestion`/plan-mode tools while active), and v2.1.84 (`allowedChannelPlugins` managed setting for admins). No later entry through v2.1.220 (the installed version) removes the "research preview" label or announces GA. `--dangerously-load-development-channels` never appears in CHANGELOG.md at all -- it is the always-available bypass path for servers not on the Anthropic-curated allowlist, confirmed by the primary docs (next finding), not a flag that graduated into `--channels`. `docs/channel.md`'s instruction to use `--dangerously-load-development-channels server:inter` is still correct: Inter's channel is a custom `.mcp.json` server, not an allowlisted plugin, so it needs the bypass flag, not `--channels`.
Source: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (fetched via api.github.com/repos/anthropics/claude-code/contents/CHANGELOG.md), lines 2911, 2878, 2822 (2.1.83 section), 2760 (2.1.84 section) -- versions 2.1.80-2.1.84, checked against HEAD as of 2026-08-05.

#### Neither flag appears in `claude --help`, confirmed both by the docs and locally
The Claude Code docs state outright: *"Neither `--channels` nor `--dangerously-load-development-channels` appears in `claude --help` while the feature is in preview. The flags work even though they aren't listed."* Verified locally: `claude --help` (installed v2.1.220) has zero matches for "channel" anywhere in its 230-line output.
Source: https://code.claude.com/docs/en/channels-reference (section "Research preview") -- fetched 2026-08-05, page states "Channels are a research preview feature" with no version pin (rolling docs page) -- cross-checked against local `claude --version` -> `2.1.220 (Claude Code)`.

#### Notification shape and capability declaration are exactly what `docs/channel.md` and `src/channel.ts` already assume
Primary docs confirm the contract verbatim: a channel is an MCP server spawned as a stdio subprocess, declares `capabilities.experimental['claude/channel']: {}` (required, always `{}`, presence alone registers the listener), optionally `capabilities.experimental['claude/channel/permission']: {}` for permission relay, and pushes `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`. `meta` keys "must be identifiers: letters, digits, and underscores only. Keys containing hyphens or other characters are silently dropped" -- matching the comment in `src/channel.ts:108-109`. This is unchanged from the research-preview contract `docs/channel.md` already documents.
Source: https://code.claude.com/docs/en/channels-reference, sections "Server options" and "Notification format" -- fetched 2026-08-05.

#### The bypass is per-entry and org policy still gates it even during preview
`--dangerously-load-development-channels` only skips the allowlist check; the `channelsEnabled` managed setting still applies on top. Combining it with `--channels` does not extend the bypass to `--channels` entries -- they are evaluated independently.
Source: https://code.claude.com/docs/en/channels-reference, section "Test during the research preview" -- fetched 2026-08-05.

### Q2 -- Rendering and supersession

#### Events render as a `<channel source="..." ...attrs>content</channel>` tag in Claude's context, and as a one-line summary in the terminal
Confirmed with an exact worked example from the primary docs: a webhook POST becomes `<channel source="webhook" path="/" method="POST">build failed on main: ...</channel>` in Claude's context, and `<- webhook: build failed on main: ...` in the terminal transcript. This matches Inter's own `CHANNEL_INSTRUCTIONS` string (`src/channel.ts:12`), which tells Claude to expect `<channel source="inter" ...>` tags.
Source: https://code.claude.com/docs/en/channels-reference, section "Notification format" -- fetched 2026-08-05.

#### Append-only is the documented reality -- there is no meta key, content convention, or notification type to replace or clear a prior message
The reference page is explicit: *"Claude Code doesn't acknowledge notifications... Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group. To process independent event streams concurrently, run separate sessions."* Nothing in the "Server options" or "Notification format" tables (the complete list of fields a channel can set) includes an id, replace-target, or supersede/clear semantic. This is not an omission being inferred -- it is the complete documented surface, and it has no such field.
Source: https://code.claude.com/docs/en/channels-reference, section "Notification format" -- fetched 2026-08-05.

#### The one "message editing" feature that exists in the ecosystem is outbound-only, and does not answer the question
The fakechat reference plugin implements `edit_message` as an MCP tool Claude can call to edit a message **it already sent** on the fakechat web UI (`broadcast({ type: 'edit', id, text })`, rendered client-side by appending `' (edited)'` to the DOM node). This is Claude editing its own prior *reply*, not a mechanism for a channel server to replace or retract an *inbound* `<channel>` event Claude already read. Checked directly in source, not inferred from the docs' passing mention.
Source: https://api.github.com/repos/anthropics/claude-plugins-official/contents/external_plugins/fakechat/server.ts, lines 36, 83-84, 121-123, 248 -- repo HEAD, fetched 2026-08-05.

**Verdict on supersession: confirmed absent**, not merely undocumented. The full notification schema is public and has no field for it, and the one editing primitive in the shipped examples operates in the wrong direction.

### Q3 -- MCP spec trajectory

#### There is no 2026-03-26 revision; the sequence is 2025-11-25 -> 2026-07-28 (current)
The spec repo's `docs/specification/` directory lists exactly: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`, `draft`. The prior finding referencing "2026-03-26 -> 2026-07-28" appears to conflate `2025-03-26` with a 2026 date -- worth correcting in Inter's own memory record.
Source: https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification -- repo HEAD, fetched 2026-08-05.

#### 2026-07-28 makes `notifications/message` (and all request-scoped notifications) strictly tied to the response stream of their originating request -- a narrowing, not a widening, of server push
SEP-2575's major change set: removes the `initialize`/`notifications/initialized` handshake and protocol-level sessions entirely (`Mcp-Session-Id` gone); replaces the HTTP GET stream and `resources/subscribe`/`unsubscribe` with `subscriptions/listen`, a single opt-in stream limited to structural change notifications (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`); and explicitly carves out that *"request-scoped notifications such as `notifications/progress` and `notifications/message` continue to flow on the response stream of the request they relate to, not the `subscriptions/listen` stream."* There is no new mechanism in this revision for a server to push arbitrary unsolicited content into a client outside of an open request/response -- if anything, the spec is formalizing that `notifications/message` was never meant for exactly the "push a message into a live session" use case this research is chasing.
Source: https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification/2026-07-28/changelog.mdx, "Major changes" items 2, 4, 5 -- revision 2026-07-28, fetched 2026-08-05.

#### The tasks primitive moved to an extension and stayed poll-based -- confirms and sharpens the prior finding
SEP-2663: *"Move experimental tasks out of the core protocol and into an official extension (`io.modelcontextprotocol/tasks`). The redesigned extension replaces the blocking `tasks/result` method with polling via `tasks/get` and a new `tasks/update` for client-to-server input, removes `tasks/list`, and allows servers to return task handles unsolicited without per-request opt-in."* Even the "unsolicited" part is about a server attaching a task handle to an existing response, not pushing a new one into an idle session -- still pull (`tasks/get`), not push.
Source: https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification/2026-07-28/changelog.mdx, "Major changes" item 6 -- revision 2026-07-28, fetched 2026-08-05.

#### Inter's own broker already targets this revision, and its own comment explains why none of this matters for portability yet
`src/cli.ts:182-190` builds its MCP handler with `legacy: "stateless"` and the comment: *"Preferred revision is 2026-07-28: stateless, no session pinning, one fresh server per request... `legacy: 'stateless'` serves 2025-era clients off the same factory -- today's CLIs (Claude Code, codex, gemini) top out at 2025-11-25, so modern-only would mean no client can connect."* This is a first-party, current confirmation that none of the clients this research cares about have caught up to 2026-07-28 at all -- so even if the new spec had added a push mechanism (it did not), no client would honor it yet.
Source: `src/cli.ts:182-190` -- this repo, HEAD at time of research.

#### No evidence any of codex/opencode/antigravity implement `subscriptions/listen` or the tasks extension (inferred, not directly verified per-client)
Client-side code or docs in codex, opencode, or antigravity confirming or denying support for the 2026-07-28 extensions were not found; absence of evidence here is `inferred` from the "2025-11-25 client cap" comment in Inter's own source plus the fact that 2026-07-28 shipped as a revision without an accompanying wave of client announcements in any of the three repos checked.

### Q4 -- Socket consumption design (`src/channel.ts` vs `src/event-socket.ts`)

#### The socket requires an explicit, pre-validated id list; channel.ts requires the opposite -- discovery with no prior ids
`handleSubscribe` rejects an empty or missing `watch` array and validates every id against the store before accepting the subscription: *"subscribe frame must contain a non-empty watch array"* and, per id, `unknownTaskMessage(id)` on any id `store.getTask(id)` does not resolve -- the whole connection gets an `ErrorFrame` and the client is expected to close. `ChannelWatcher.apply()` in `src/channel.ts`, by contrast, is handed the **entire unarchived task list** on every poll and has no concept of "ids to watch" -- it discovers brand-new tasks (just delegated, never seen before) simply because `/api/state` always returns everything.
Source: `src/event-socket.ts:234-251` -- `src/channel.ts:77-100` -- this repo, HEAD.

#### The socket auto-drops settled ids and closes the connection once the watch set empties -- it is a bounded "watch until done" primitive, not a standing feed
`runLoop` filters `state.taskIds` down to non-settled ids after every batch and returns (ending the loop, closing the socket) once none remain: *"When none remain the client has everything it came for; the close is its move..."* This is exactly right for `inter watch <taskId>` (watch N known tasks to completion, then exit) and exactly wrong for channel.ts's actual job, which never wants to close -- it discovers new worthy tasks for the life of the Claude Code session.
Source: `src/event-socket.ts:349-365` -- this repo, HEAD.

#### `BatchTask` does not carry the fields `eventContent()` needs to build a message
`BatchTask` (`src/event-socket.ts:39-46`) carries only `id`, `state`, `question?`, `error?`, `title?`, `archivedAt?`. `TaskView` (`src/channel.ts:35-46`), which `eventContent()` actually reads from, additionally needs `profileId`, `cwd`, `output`, and `completion.{code,reason}` -- used to build the `outcome:`/`reason:`/`profile:`/`cwd:` lines in every state branch of `eventContent()`. Even under a socket-based redesign, channel.ts needs a second read (a task-detail call, e.g. reusing `inspect`) for any task that just transitioned into a worthy state -- the socket batch alone is not enough to render the notification text Inter currently ships.
Source: `src/event-socket.ts:39-46` (BatchTask) vs `src/channel.ts:35-46` (TaskView) and `src/channel.ts:121-156` (`eventContent()` field reads) -- this repo, HEAD.

#### Recommended design: hybrid -- cheap id/state discovery poll + event-socket subscription over the tracked non-settled set
Given the two primitives cannot be swapped one-for-one, the lowest-risk fix that still cuts the 564KB/poll sink is:
1. Poll a cheap, id+state-only endpoint (not full `/api/state` task rows) on a longer interval than today's 1s -- this interval only bounds *discovery latency for brand-new tasks*, which is far less time-sensitive than settle notification.
2. Open one `connectEventSocket` subscription (reusing the exact client already built for `inter watch`) over the current set of known non-settled task ids, for low-latency `needs_input`/`completed`/`failed`/`blocked` notification the instant it happens.
3. On any batch reporting a settle, fetch that one task's detail (for the `eventContent()` fields the batch does not carry) and emit the channel notification -- not a per-poll full-state read.
4. Reconnect the socket (new `watch` list) whenever the discovery poll finds a new task or the tracked set otherwise changes; on `SocketStreamDeath`/`SocketConnectError`, fall back to the discovery poll alone until the broker comes back, exactly as `inter watch`'s CLI already does.

Trade-off against the alternative (extend the socket protocol itself with a subscribe-all/firehose mode that never auto-closes and needs no prior ids): the hybrid ships with zero `src/event-socket.ts` protocol changes and reuses code that already exists and is tested (`connectEventSocket`), at the cost of periodic reconnect churn as the tracked set changes on a busy broker (each reconnect re-validates every id via `store.getTask`). A firehose mode would be architecturally cleaner for channel.ts's actual (unbounded, discovery-first) use case, but is a real protocol/server change and is out of scope for this read-only research task's guardrails.

### Q5 -- Alternatives for non-Claude clients

#### codex: unchanged, still routes `notifications/message` away from the model
Three issues remain open, all last active in June 2026, none closed or referencing a merged fix:
- #15299 "Support inbound MCP notifications routed into an active Codex CLI session" -- open, created 2026-03-20, updated 2026-06-24, 14 comments.
- #17543 "Support injecting MCP custom notifications into Codex sessions" -- open, created 2026-04-12, updated 2026-06-21, 8 comments.
- #18056 "Feature request: surface MCP `notifications/message` to the model's conversation (not just tracing)" -- open, created 2026-04-16, updated 2026-06-21, 7 comments.
Source: https://api.github.com/repos/openai/codex/issues/{15299,17543,18056} -- fetched 2026-08-05.

#### codex's hooks are reactive to its own turn lifecycle only, not an external-injection surface
codex hooks fire at `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `SessionStart`, `SubagentStart`, `SessionEnd` -- every one of these is triggered by codex's own execution, not by an outside system wanting to inject a new message asynchronously. There is no hook event for "external system has news for you right now."
Source: https://developers.openai.com/codex/hooks.md, section "Hooks run at different points in a conversation" -- fetched 2026-08-05.

#### opencode: a genuinely new, documented alternative -- `POST /session/:id/prompt_async`
opencode's local server (`opencode serve`, also embedded whenever the TUI runs) exposes `POST /session/:id/prompt_async` -- *"Send a message asynchronously (no wait)"*, returning `204 No Content` -- and `POST /tui/append-prompt` -- *"Append text to the prompt"*. Either is a real, working way for an external process (Inter's channel watcher, for instance) to inject a new user-role message into a running opencode session, with no MCP extension, no allowlist, and no research-preview gate. This is materially different from Claude Code's channel and from anything codex or antigravity offer.
Source: https://opencode.ai/docs/server, "Sessions" and "TUI" API tables -- fetched 2026-08-05.

#### opencode plugins get a full event bus and an SDK client "for interacting with the AI" -- plausible but unverified path to the same push
Plugins can subscribe to `session.idle`, `message.updated`, and 20+ other events, and receive a `client` object described only as "An opencode SDK client for interacting with the AI." Whether that client wraps `prompt_async` directly (letting a plugin push a message without an HTTP round-trip) is not stated on this page and the SDK reference was not opened to confirm it -- `inferred`, not verified.
Source: https://opencode.ai/docs/plugins, sections "Basic structure" and "Events" -- fetched 2026-08-05.

#### antigravity: public docs exist now, MCP is supported, but there is no push-into-session surface -- same shape as codex
`antigravity.google/docs` (Antigravity 2.0, IDE, CLI, and SDK, versions v2.5.0/v1.1.10/v2.1.1/v0.1.9 respectively at fetch time) documents full MCP client support (stdio, SSE, Streamable HTTP, OAuth, Google ADC) across all four product surfaces, and a `hooks.json` lifecycle-hook system with `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` events -- structurally identical to codex's hooks and equally reactive-to-its-own-turn-only. Nothing in the MCP or Hooks pages describes a server-initiated or externally-triggered message injection into a running session.
Source: https://antigravity.google/docs/mcp and https://antigravity.google/docs/hooks -- fetched 2026-08-05.

#### pi: extensions can push a real user message into the live session, with delivery-mode control -- the richest surface of the five clients
A pi extension is a TypeScript module in `~/.pi/agent/extensions/` (or trust-gated `.pi/extensions/` per project). The extension API provides `pi.sendUserMessage(content, options?)`: *"this sends an actual user message that appears as if typed by the user. Always triggers a turn."* Delivery modes: `"steer"` (queued while streaming, delivered after the current assistant turn's tool calls, before the next LLM call), `"followUp"` (delivered when the agent has no more tool calls), `"nextTurn"` (queued for the next user prompt, no interrupt), plus `triggerTurn: true` to make an idle agent respond immediately. Injected messages are distinguishable downstream: message events carry `source: "extension"` and `streamingBehavior: "steer" | "followUp"`, so an adapter can avoid reacting to its own injections. External integrations are an explicitly documented use case ("file watchers, webhooks, CI triggers"); the one constraint is that background resources (processes, sockets, watchers, timers) must not be started from the extension factory -- start them on `session_start`.
Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md (sendUserMessage section, "What Extensions Can Do", factory constraint) · pi-coding-agent 0.83.0, repo HEAD 588915e, 2026-08-04, fetched 2026-08-05.

#### pi: supersession exists -- named UI widgets and non-context transcript entries
`ctx.ui.setWidget("inter", [...lines])` renders a widget above the editor keyed by name -- writing the same key replaces the previous content, which is exactly the "clear the UI after each message" behavior no other client offers. `ctx.ui.setStatus(key, text)` does the same for the footer, and `ctx.ui.notify(text, level)` gives fire-and-forget toasts. Separately, `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer()` renders cards inside the chat transcript that "do NOT participate in LLM context" -- ambient event display with zero token cost. Widget/status/notify work in TUI and RPC modes (`ctx.hasUI` guards; no-ops in print/json mode, which is how Inter drives pi as a worker -- the adapter targets pi as an interactive caller, where hasUI is true).
Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md (ctx.ui section, appendEntry section, hasUI note) · pi-coding-agent 0.83.0, fetched 2026-08-05.

#### Per-client adapter verdicts
- `ADAPTER FEASIBLE: Claude Code — yes — claude/channel stdio MCP server (src/channel.ts, exists) — research preview, needs --dangerously-load-development-channels, v2.1.80+; append-only, no supersession`
- `ADAPTER FEASIBLE: pi — yes — extension in ~/.pi/agent/extensions/ subscribing to the event socket on session_start, pushing via pi.sendUserMessage (pointer + inspect instruction) and superseding a "inter" ctx.ui.setWidget — ungated, pi-coding-agent 0.83.0; richest surface: steer/followUp/triggerTurn + widget supersession`
- `ADAPTER FEASIBLE: opencode — yes — POST /session/:id/prompt_async on the local server (or possibly an opencode plugin via its SDK client, unverified) — ungated, documented; append-only`
- `ADAPTER FEASIBLE: codex — no — notifications/message goes to tracing, hooks are lifecycle-reactive only; open feature requests #15299/#17543/#18056 — backgrounded inter watch remains the mechanism`
- `ADAPTER FEASIBLE: antigravity — no — MCP client support but hooks are lifecycle-reactive only, no injection surface found in antigravity.google/docs — backgrounded inter watch remains the mechanism`

#### The portable floor is unchanged: a backgrounded `inter watch <taskId>` exit is still the only thing that works identically everywhere
No finding above changes this. Claude Code channels are an accelerator on top of it; opencode's `prompt_async` and a pi extension are promising *additions* each worth their own adapter, not replacements for the floor, since each is client-specific just as channels are Claude-Code-specific.

## Open Questions

- Does pi support MCP servers as a client, and how do their notifications fare? Not investigated — the extension surface already provides strictly more than MCP notifications could, so the adapter does not depend on the answer.
- Does opencode's plugin `client` object expose `prompt_async` (or equivalent) directly, making an in-process opencode plugin viable, versus Inter's channel watcher having to hit the HTTP API from outside? Not verified -- would require opening the `@opencode-ai/plugin`/SDK type definitions.
- Has `--channels` graduated past "research preview" in any Claude Code release newer than v2.1.220 (the version installed in this environment)? Not checkable from here.
- Could codex's `UserPromptSubmit` hook, or antigravity's `PreInvocation` hook, be abused to splice in queued external text right before the next turn starts? This is a poll-adjacent hack (it still needs something to have written the text somewhere first), not true push, and it was not prototyped.
- Whether the 2026-07-28 MRTR pattern (`InputRequiredResult`) has any long-term bearing on a push design -- it addresses a server pausing mid-*response* to ask the client for more input, not an out-of-band push into an idle session, so it looked out of scope, but every touchpoint was not fully traced.
- No official `google/antigravity` GitHub repo was found (only third-party tooling that targets it) -- docs-only verification for that client throughout this research; source code claims about antigravity could not be cross-checked the way codex and Claude Code's own docs/plugin source could.

## Sources

- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (fetched via GitHub Contents API, anthropics/claude-code, HEAD 2026-08-05)
- https://code.claude.com/docs/en/channels (fetched 2026-08-05)
- https://code.claude.com/docs/en/channels-reference (fetched 2026-08-05)
- https://api.github.com/repos/anthropics/claude-plugins-official/contents/external_plugins/fakechat/server.ts (repo HEAD, fetched 2026-08-05)
- https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification (repo HEAD, fetched 2026-08-05)
- https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification/2026-07-28/changelog.mdx (revision 2026-07-28, fetched 2026-08-05)
- https://api.github.com/repos/openai/codex/issues/15299 (fetched 2026-08-05)
- https://api.github.com/repos/openai/codex/issues/17543 (fetched 2026-08-05)
- https://api.github.com/repos/openai/codex/issues/18056 (fetched 2026-08-05)
- https://developers.openai.com/codex/hooks.md (fetched 2026-08-05)
- https://opencode.ai/docs/plugins (fetched 2026-08-05)
- https://opencode.ai/docs/server (fetched 2026-08-05)
- https://antigravity.google/docs/mcp (Antigravity 2.0 v2.5.0 / IDE v2.1.1 / CLI v1.1.10 / SDK v0.1.9, fetched 2026-08-05)
- https://antigravity.google/docs/hooks (fetched 2026-08-05)
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md (pi-coding-agent 0.83.0, repo HEAD 588915e 2026-08-04, fetched 2026-08-05 — pi section added by the coordinator after the addendum worker hit a rate limit)
- docs/pi.md, docs/pi-provider-research.md (this repo, HEAD — pi extension trust model, --no-approve rationale)
- src/channel.ts (this repo, HEAD)
- src/event-socket.ts (this repo, HEAD)
- src/cli.ts:175-190 (this repo, HEAD)
- docs/channel.md (this repo, HEAD)
- Local: `claude --version` -> `2.1.220 (Claude Code)`; `claude --help` (230 lines, no "channel" match)
