# Inter channel (Claude Code)

A channel is an MCP server that Claude Code spawns as a stdio subprocess and
that pushes events into the live session. The Inter channel watches the
broker's HTTP API and pushes a notification when a delegated task reaches a
state worth waking the caller about: `needs_input`, `completed`, `failed`,
`blocked`, or `cancelled`.

## What this is — and is not

The channel is **optional, and it is Claude Code only.**

- `notifications/claude/channel` is an Anthropic extension. Codex, opencode,
  and antigravity cannot receive it. Codex in particular receives standard
  `notifications/message` but routes it to Rust tracing, so its model never
  sees it.
- **The portable follow-along mechanism — the one that works in every MCP
  client — is a backgrounded `inter watch`, with the MCP `wait` tool for short
  deliberate blocks.** Both are covered in
  [follow-along.md](follow-along.md). You do not need the channel to follow a
  task, and it does not help on codex or opencode.

Think of the channel as an accelerator on top of that portable mechanism: in
Claude Code it wakes the caller on its own, so the caller is not relying on a
loop to notice a `needs_input` or a completion.

## How it works

`src/channel.ts` is a separate process from the broker (the broker is a
long-lived HTTP server on port 7331; Claude Code owns the channel as a stdio
subprocess). It:

1. connects to Claude Code over stdio,
2. polls `GET /api/state` on an interval, and
3. emits one `notifications/claude/channel` notification when a task
   transitions into `needs_input`, `completed`, `failed`, `blocked`, or
   `cancelled`.

Churn — `queued`, `running`, `answered`, heartbeats — produces nothing, and
each state is announced at most once per task for the life of the process. If
the broker is down the channel backs off and retries; it never exits on its
own, because a channel that dies takes its events with it.

Only `needs_input` is announced on the first poll after a session opens: a task
already waiting on you is worth interrupting a fresh session for, and a task
that finished yesterday is not.

## Its own tools

A Claude Code session connected through the channel sees the channel's tools,
not the broker's, so the channel carries the two actions a pushed event most
often calls for:

- `cancel(taskId, reason?)` — stops a task and its worker process tree.
  `reason` defaults to `"cancelled by channel client"`.
- `resume(taskId, instruction?)` — retries a `failed`, `cancelled` or `blocked`
  task on its existing provider session. Omit `instruction` to continue as-is.

Both proxy the broker's REST routes and return its answer verbatim, including
its errors for an unknown task or a state that cannot take the call. See
[cancel.md](cancel.md) and [resume.md](resume.md) for the full semantics.

Its `instructions` string lands in Claude's system prompt and tells the
receiving Claude how to act on each state — answer `needs_input` questions
with Inter's `reply` tool directly, verify `completed` work, decide between
`resume` and re-delegate for `failed`/`blocked`, and treat `cancelled` as
settled unless it wants to resume — without implying the channel is the only
way to learn about a task. It escalates to the user only for product intent,
secrets, destructive actions, or authority not already granted.

## Setup

Add the entry to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "inter": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "src/channel.ts"],
      "env": { "INTER_PORT": "7331" }
    }
  }
}
```

Run it from the repo root (the `src/channel.ts` path is relative).
`INTER_PORT` must match the broker's port (`Bun.env.INTER_PORT`, default 7331).
The server name must match the one the launch flag references, so a project
`.mcp.json` entry named `inter` shadows the global HTTP `inter` entry in that
project.

## Launch

During the research preview a custom channel is not on the approved allowlist,
so launch Claude Code with the development-channel flag, naming the server:

```bash
claude --dangerously-load-development-channels server:inter
```

Events only arrive while a session is open: the channel is a stdio subprocess
of that session, so closing it stops the pushes. A closed session drops
notifications silently, and several notifications arriving while Claude is
busy are delivered together on the next turn.

## Notes

- The channels contract is a research preview and may change; nothing else in
  the app builds on it.
- Do not edit `.mcp.json` from this repo; the entry above is the one to add
  to the user's project config.
