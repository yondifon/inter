# Inter channel (Claude Code)

A channel is an MCP server that Claude Code spawns as a stdio subprocess and
that pushes events into the live session. The Inter channel watches the
broker's HTTP API and pushes a notification when a delegated task reaches a
state worth waking the caller about: `needs_input`, `completed`, `failed`, or
`blocked`.

## What this is — and is not

The channel is **optional, and it is Claude Code only.**

- `notifications/claude/channel` is an Anthropic extension. Codex, opencode,
  and antigravity cannot receive it. Codex in particular receives standard
  `notifications/message` but routes it to Rust tracing, so its model never
  sees it.
- **The portable follow-along mechanism — the one that works in every MCP
  client — is a blocking `wait` call with `until: "attention"` and a real
  timeout.** It blocks up to 30 seconds and returns the instant the task asks
  a question or reaches a terminal state. You do not need the channel to
  follow a task, and it does not help on codex or opencode.

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
   transitions into `needs_input`, `completed`, `failed`, or `blocked`.

Churn — `queued`, `running`, `answered`, heartbeats — produces nothing, and
each state is announced at most once per task for the life of the process. If
the broker is down the channel backs off and retries; it never exits on its
own, because a channel that dies takes its events with it.

Its `instructions` string lands in Claude's system prompt and tells the
receiving Claude how to act on each state — answer `needs_input` questions
with Inter's `reply` tool directly, verify `completed` work, and decide
between `resume` and re-delegate for `failed`/`blocked` — without implying the
channel is the only way to learn about a task.

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
