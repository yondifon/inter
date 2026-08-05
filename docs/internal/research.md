# CLI research

Checked 2026-07-29 against official docs and installed CLI help.

## Shared adapter contract

Inter uses argv arrays, explicit workspace roots, provider/model selection, machine
readable output, and provider-owned auth. It does not copy credentials or emulate
each CLI's internal subagent runtime.

## Claude Code

- Official CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Installed help confirms print mode, JSON/stream JSON, model selection,
  `--permission-mode`, resume/continue, background agents, and MCP config.
- Account isolation uses the existing `CLAUDE_CONFIG_DIR` pattern in
  `~/.dotfiles/symlinks`.

## Codex

- Codex manual fetch was unavailable during research; installed `codex --help` and
  `codex exec --help` supplied the current local contract.
- Verified: `exec`, `review`, `mcp-server`, `--json`, `--model`, `--profile`,
  `--cd`, sandbox selection, output schema, and session resume.
- Inter uses `codex exec --json` with workspace-write sandboxing.

## OpenCode

- Official CLI reference: https://opencode.ai/docs/cli/
- Verified: `run --format json`, `provider/model`, `--dir`, `--agent`,
  session resume/fork, headless server, and account/provider management.

## Antigravity

- Official CLI reference: https://antigravity.google/docs/cli/reference
- Subagents: https://antigravity.google/docs/cli-subagents
- MCP: https://www.antigravity.google/docs/mcp
- Official docs expose background agents, task manager, MCP, permissions, and
  model selection. No runnable `antigravity` binary exists on this machine, so
  the prototype keeps this adapter disabled and supports a custom command
  template once the installed non-interactive contract is known.

## Prototype decisions

- Async task handles beat one blocking MCP call; host timeouts vary.
- `needs_input` is explicit state. Parent calls `reply`; MCP cannot portably push
  a new parent turn across all clients.
- Profile env selects accounts. Secret-like env values never leave the server.
- `INTER_ROOTS` prevents a parent from delegating outside configured projects.
- Oga proved routing/config ideas, but Inter omits its boss, checker, pane, and
  orchestration layers for this first slice.
