# Pi provider

`pi` is the coding agent from [earendil-works/pi](https://github.com/earendil-works/pi),
npm `@earendil-works/pi-coding-agent`. Inter drives it in JSON mode, one shot per
task, exactly like the other four providers.

Every flag below was traced to pi's own source during development. The flags,
the event stream, resume, tool calls, and model listing were then **exercised
against pi 0.82.1** — see [Verified](#verified) and
[Still unverified](#still-unverified).

## Dispatch

```
pi --mode json --model <model> [--thinking <effort>] --no-approve <prompt>
```

| Flag | Why |
| --- | --- |
| `--mode json` | One shot, and every session event as JSON lines on stdout. `-p` is redundant. |
| `--model` | Always provider-qualified (`opencode/kimi-k3`). A bare id resolves to the first catalog entry that matches it. |
| `--thinking` | pi's ladder is `off,minimal,low,medium,high,xhigh,max` — a superset of Inter's, so efforts pass through unchanged. Inter never sends `off`. |
| `--no-approve` | Project trust, not tool approval: it keeps the delegated repo's `.pi/` settings and extensions out of the run. pi extensions run with full system access, so a repo Inter was pointed at must not be able to load one. |
| `<prompt>` | Trailing positional. |

There is **no cwd flag**. pi reads `process.cwd()`, so the spawn's cwd is what
scopes the run.

pi ships no sandbox and no permission gate of its own: `read`, `bash`, `edit`,
and `write` execute immediately. Inter's `sandbox-exec` profile is the only
boundary, and there is correspondingly nothing that can stall waiting for
approval.

## Resume

```
pi --mode json --model <model> [--thinking <effort>] --no-approve --session-id <id> <prompt>
```

The id comes from the `{"type":"session","id":…}` header, which is the stream's
first line and is never repeated.

`--session-id` is the only headless-safe option. `--session` prompts on stdin
when the id belongs to another directory, `-r` opens an interactive picker, `-c`
is not addressable by id, and `--fork` copies rather than continues.

**Resume must run in the original cwd.** pi looks sessions up per directory. On a
miss it warns on stderr, starts a *fresh* session under that id, and still exits
0 — silent context loss rather than an error.

## Sandbox

pi writes its transcript to `~/.pi/agent/sessions/<encoded-cwd>/` as the run
goes, and refreshes `auth.json` and the model catalog in place. `task-scope.ts`
grants `~/.pi`; without it a run still completes but leaves no session behind, so
the next resume starts empty. `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR` are the two profile env vars that relocate those
trees, and both are on the allowlist.

## Discovery

pi is the one provider found by **executable only**. The other four also match on
a config directory, but `~/.pi/agent/` outlives an uninstall, and pi's own trust
rules treat a bare `.pi` as no signal — matching on it would mint a profile that
dies at spawn.

## Models

`pi --list-models` prints a padded table, not JSON: a header row, then
`provider  model  context  max-out  thinking  images` with columns separated by
two or more spaces and widths recomputed per invocation. Inter keys off the
header row and splits on the gap. Only models with working auth are listed, and
the two failure outputs are prose, which parse to nothing and fall back to the
profile's configured model.

A row with `thinking: yes` gets the whole effort ladder: pi takes `--thinking` as
a session flag rather than publishing a ladder per model, the same as Claude.

## Failure detection

`--mode json` **exits 0 even when the model errored.** The exit code is not a
signal. The turn's outcome is `message_end.message.stopReason` — `error` or
`aborted`, with `errorMessage` alongside — which `events.ts` surfaces as a failed
event. `agent_settled`, not `agent_end`, is the terminal event: `agent_end` can
carry `willRetry: true`.

## Verified

Against **pi 0.82.1** (`~/.bun/bin/pi`), model `opencode-go/deepseek-v4-flash`:

- **Flags.** Every flag above exists in `pi --help`, with `--thinking` taking
  exactly `off, minimal, low, medium, high, xhigh, max`. No `--cd`/`--cwd`/`--dir`
  exists anywhere in the help output.
- **Event stream.** A real run emits `session`, `agent_start`, `turn_start`,
  `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`,
  `agent_settled` — all shapes as parsed.
- **`sessionIdFrom`** finds the id on the `session` line and nowhere else.
- **`finalText`** returned `"pi-adapter-ok"` from a real reply, and the tool run's
  closing summary from a multi-step one.
- **Exit-0-on-error is real.** An expired key produced
  `stopReason: "error"`, `errorMessage: "401 … Invalid API key."`, **exit 0**.
  Inter reads the stop reason, so the task fails correctly instead of reporting
  success.
- **Resume works.** `--session-id` with the captured id returned the same session
  id and the model recalled the previous turn's answer, so history genuinely
  carried.
- **Tools.** `write` arrives as `tool_execution_start` with `args.path`; `bash` as
  `args.command`. `tool_execution_end` carries `args: null`, so the path is only
  available on the start event.
- **Model table.** The real 77-model catalog parses with no malformed ids.

Two defects were found this way and fixed:

1. pi echoes the prompt back as a `message_start`/`message_end` pair with
   `role: "user"`, which rendered as "Agent message" until the role was checked.
2. On 0.82.x every `toolcall_delta` also carries the message so far, so
   `writeTargetsFrom` read half-streamed paths — `pro`, `probe`, then
   `probe.txt`. Streaming deltas are now skipped.

## Under Inter's sandbox

A full task ran through `delegate()` and `sandbox-exec`: state `completed`,
exit 0, the file written with exactly the requested contents, the session id
captured, and pi's transcript landing in
`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`. Resuming that
session in the same cwd returned the same id and recalled the file it had
created, so history survives the sandbox.

Getting there took three fixes to shared sandbox code, none of them pi-specific
in nature — pi is just the first provider that is a **script** rather than a
compiled binary:

1. **Ancestor metadata.** Launching a CLI stats every component of its path. A
   binary in `/opt/homebrew` inherits that blanket grant; one under `$HOME` does
   not, and nothing covered `/Users` or `/Users/<name>`. Node died on
   `EPERM lstat '/Users'`.
2. **The interpreter.** `#!/usr/bin/env node` means the *interpreter* is a second
   executable that also has to be granted, along with its install prefix, which
   Node stats while building its module search path. Without it the run
   segfaulted with no output at all — `exit 139`, empty stderr. `task-scope.ts`
   now reads the shebang and grants what it names.
3. **The worker's PATH.** `workerPath()` only merged the login shell's PATH when
   something had already failed to resolve. That found `pi` but not the `node`
   its shebang re-resolves through `env`, so the worker died on
   `env: node: No such file or directory`. It is now loaded up front, once.

Also: `~/.pi/agent/AGENTS.md` is commonly a dotfiles symlink, and the symlink
scan only looks one level below each granted config dir. `~/.pi/agent` is listed
alongside `~/.pi` so the target is granted; otherwise every run logs two EPERM
warnings on stderr.

## Still unverified

1. **Prompt as positional.** pi honours no `--` separator, so a prompt opening
   with `-` parses as an unknown flag and one opening with `@` as a file
   argument. Inter's prompts are markdown and start with `#`, but a `reply`
   answer is free text.
2. **Resume cwd mismatch.** Resume is pinned to the original cwd, but the stderr
   warning that signals a silent miss is not parsed.
3. **Extensions in json mode.** pi extensions can register flags and request
   interactive UI. Whether a json-mode run can block on one is undocumented.
   `--no-approve` keeps repo-local extensions out; user-level ones still load.

## Version sensitivity

pi self-updates: it reported **0.82.1** at the start of this work and **0.83.0**
an hour later, with `~/.bun/bin/pi` relinked underneath. Treat the version as
moving. The gap is not cosmetic: 0.83.0's unreleased line **removes** the
cumulative `message` from `message_update`, which is exactly the field that
produced defect 2 above. Skipping the deltas is correct on both sides of that
change, but a future parser that starts trusting `message_update.message` will
behave differently per version. Re-check on upgrade.

## Operational note

**pi blocks forever on an open stdin.** In print and json mode it merges piped
stdin into the prompt, so a pipe that never closes hangs the process before any
API call. `Bun.spawn` defaults stdin to `ignore`, so Inter's worker spawn is
already safe — but any manual `pi --mode json` invocation needs `< /dev/null`.
