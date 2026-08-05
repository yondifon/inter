# Inter debug sweep — 2026-08-03

Live exercise of every MCP tool against the running broker, cwd `/Users/malico/desgn/inter`.
Broker `0.6.0`, MCP contract `19` — matches `MCP_CONTRACT_VERSION` in `src/cli.ts:38`, so the installed
app is not stale.

11 tasks dispatched across `opencode`, `pi`, `codex`, `antigravity`.

## Works

| Path | Evidence |
| --- | --- |
| `health` | `{status: ok, version: 0.6.0, mcpContractVersion: 19}` |
| `delegate` → `completed` | `9cd2c872` (opencode) returned the export inventory in 12s |
| `needs_input` → `reply` → `completed` | `acea4994` (pi) asked, took the answer, wrote `.inter-test/pi-ask.txt` |
| sandbox denial → `suggestedScope` → `resume` | `cc6fd41c`: refused, resumed with the suggested scope, write landed |
| `cancel` | `ae0924a3` stopped mid-run, no orphan worker left |
| `archive` | hidden from the active list, still addressable by ID |
| `tasks parent:` | fan-out returned 6/6 children |
| `memory` list/set/get/remove | round trip clean; stale write rejected: `memory version conflict: expected 99, found 1` |
| grant reuse | scope-less dispatch inherited the newest grant **for that profile**, not for the cwd |
| honest completion | worker that skipped the marker → `unverified`, not `completed` |

## Broken

### P1 — `codex` is dead and Inter reports the wrong reason

`641eebbe` failed in 19s. Surfaced error:

```
Reading additional input from stdin...
```

That is a benign codex CLI stderr notice. The real message was in `output`:

```
Your workspace is out of credits. Ask your workspace owner to refill in order to continue.
```

Cause: `src/task-protocol.ts:102` — `stderr.trim() || output.trim()`. stderr always wins, so any
chatty provider notice masks the actual failure. Two earlier codex tasks (`000257a6`, `b58a2f5d`)
carry the same fake error; they were out-of-credits too.

### P1 — the failure classifier can't see "out of credits"

`src/task-protocol.ts:165`:

```ts
if (/\b(?:insufficient balance|credits?error|billing|payment required)\b/i.test(value)) return "billing";
```

`credits?error` is a typo — it matches `crediterror`/`creditserror`, nothing real. Verified against the
live message: `billing: false auth: false rate_limit: false`.

The knock-on: `recordProfileTaskOutcome` (`src/tasks.ts:690`) only records `auth`, `billing`, and
`rate_limit`. A `worker_error` is dropped, so codex is never marked unavailable — and `route` still
ranks `codex/gpt-5.6-luna` at score 40 as a live candidate. Every dispatch burns ~20s and fails.

### P1 — `antigravity` cannot start: one unreachable CDN host

`d304dc9b` ran 100s, then:

```
Run summary: Eligibility check failed: failed to get profile picture:
Get "https://lh3.googleusercontent.com/a/...=s96-c":
dial tcp [2c0f:fb50:4003:803::2001]:443: connect: no route to host
```

Not sandbox-related — the sandbox profile allows `(allow network*)` (`src/task-scope.ts:103`), and the
host is unreachable from the shell too:

```
google.com            301  0.69s
api.anthropic.com     404  0.11s
lh3.googleusercontent.com  000  8.00s (timeout)
```

The antigravity CLI blocks its own startup on fetching a Google profile picture. Nothing Inter can fix
in-process, but 100s of dead wall-clock per dispatch is worth a fast fail.

### P2 — profile status is stale, wrong, and `refresh` doesn't touch it

`profiles` reports all 11 antigravity models as `"Observed authentication failure"`, `checkedAt`
`2026-08-02T22:19:09Z` — 23 hours old, and the wrong cause. A fresh failure today did not update it,
including with `refresh: true`, because `worker_error` never rewrites the record (`src/tasks.ts:690`).
`refresh` only bypasses the cache on provider-called sections, not the task-observed failure store.

### P2 — `profiles` with all sections is too big to call

`include: ["models","status","usage"]` returned 83,062 chars / 3,501 lines and was rejected by the MCP
token cap. 142 model entries dominate. As shipped, the "one capacity read" the tool description
promises cannot be performed in one call.

### P2 — the `pi` adapter emits one event per token

A single short pi reply produced ~100 `agent.message_update` events, each carrying one token
(`Thinking: The`, `Thinking: task`, `Thinking: is`, …). One `wait` call returned a wall of them.
opencode emits step-level events for the same work.

Accidental workaround: `afterCursor: 99999999` suppresses the event list entirely. It works, but it is
a side effect, not an API — there is no documented "state only, no events" read.

### P3 — smaller things

- **Stating scope silently narrows the cwd grant.** The deny test left opencode's grant at
  `.inter-test/allowed/**` + one file; the next scope-less dispatch inherited it with no warning.
  Grants are per profile+cwd — antigravity kept `.inter-test/**` while opencode was narrowed.
- **`delegate` echoes ~5k tokens per call** — `prompt`, `shippedPrompt`, and every memory verbatim.
- **Named profile ≠ named model.** `opencode` returned `deepseek-v4-flash` and `kimi-k3` on different
  prompts, driven by inferred task class in `.inter.toml`. Correct per config, invisible at the call site.
- **`task.updatedAt` doesn't move during a run** — antigravity sat at `createdAt` for 100s while
  `progress` showed live events.
- **`pi` is in no `.inter.toml` allow list**, so auto-routing can never select it; only an explicit
  `profile: "pi"` works, and it warns each time.

## Fix order

1. `src/task-protocol.ts:102` — prefer the output's terminal error over chatty stderr, or merge both.
2. `src/task-protocol.ts:165` — fix the `credits?error` regex; add `out of credits`, `quota`, `refill`.
3. `src/tasks.ts:690` — record `worker_error` too, or at least refresh `failedAt` on any repeat failure.
4. `profiles` — paginate or summarise `models`; today the full read is uncallable.
5. pi adapter — coalesce token deltas into step-level events.

## Leftovers

- `.inter-test/denied-probe.txt` and `.inter-test/pi-ask.txt` are test artifacts.
- opencode's grant for this cwd is still the narrow `.inter-test/allowed/**` + `.inter-test/denied-probe.txt`.
  The next scope-less opencode dispatch inherits it.
