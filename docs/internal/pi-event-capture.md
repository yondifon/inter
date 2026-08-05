# Pi event capture: what an event is, what gets dropped, and why pi traces go silent

Diagnosis written 2026-08-04 against the working tree at `77d0583`, with every
claim checked against the live broker database (`~/.inter/inter.db`) and
opencode's own session store (`~/.local/share/opencode/opencode.db`). No source
was edited; no worker was spawned. Four pi tasks ran today and were watched
closely; the observations that prompted this document are labelled below and
each is either confirmed or corrected against the code and the rows.

## TL;DR

- **An event on pi is one stdout JSONL line.** `pi --mode json` emits one
  session event per line; Inter stores each parseable line as one `TaskEvent`
  (`tasks.ts:493-494`), so the stored trace inherits pi's wire granularity —
  one row per token, because pi streams `message_update` deltas one token at a
  time. opencode and claude emit at message/step granularity, so their rows are
  one per tool call. Nothing in Inter re-granulates.
- **The 9–10 minute silences are not pi, not the pipe, not `wait`.** All four pi
  runs today burned the 5,000-event cap in ~60 s of token streaming, hit
  `events_truncated`, and *every subsequent line was then ignored* — including
  the tool events for work the worker demonstrably did (files kept changing).
  Capture stop is permanent for the run, so the trace freezes while the worker
  works. Proved from the DB: each run stores exactly 5,000 agent events, then
  nothing until completion.
- **`stalled: true` is meaningless on pi.** It is derived from
  `silentMs = now − lastAgentEventAt` (`tasks.ts:443`), a clock that only the
  line handler advances (`tasks.ts:499`). Capture stop freezes that clock
  forever, so the heartbeat reports the worker as stalled while it is editing
  files. Measured: `silentMs` up to 703,469 on a run that completed normally.
- **The recurring ~99 KB `event_dropped` on opencode is a large tool result.**
  Identified from opencode's own store: the dropped line is the stream event
  carrying the first big file `read` (full file in `part.state.output`). E.g.
  part `prt_fca2c8bdf` (read of `TaskDetailView.swift`, 100,842 B stored) was
  dropped as a 101,068 B line — 226 B of envelope. Same class on pi: a
  `turn_end` tool-results echo. Only the *first* oversized line per run is even
  logged; every later one vanishes silently.
- **Fix: coalesce pi's token deltas at capture time**, not in the view layer —
  one stored row per content block (or a 1 s flush), matching what
  `message_end` and the `tool_execution_*` pair already deliver; and make
  liveness a pipe-activity signal, not an event-storage signal.

## What an event is on pi

The wire unit is one LF-delimited JSON line on stdout from
`pi --mode json` (`adapters.ts:54-69`), in pi's own session-event vocabulary:
`session`, `agent_start`, `turn_start`, `message_start`, `message_update`
(with `assistantMessageEvent.type` ∈ `text_start|text_delta|text_end|
thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|
toolcall_end`), `message_end`, `turn_end`, `agent_end`, `agent_settled`,
`tool_execution_start|update|end`. Inter converts **one line → one stored
`TaskEvent`** unconditionally in the stdout handler: parse, then
`appendTaskEvent(task.id, "agent." + payload.type, …)` at `tasks.ts:493-494`,
subject only to the three capture limits below. The decision point is that
handler — not `events.ts`, which never sees most of the stream and only renders
what was already stored.

That makes the stored granularity a direct inheritance from the provider's
wire protocol:

- **pi** streams token deltas, so a single reply becomes ~80 stored events per
  second (measured: 4,914 `message_update` rows in 63 s, 4,365 of them
  `thinking_delta` — one row per thinking token).
- **opencode** emits one event per step/tool part (`step_start`, `tool_use`,
  `step_finish` — verified from today's rows), so its trace is one row per tool
  call, each independently readable.
- **claude** (stream-json) emits one event per message and per `tool_use`
  block, so its rows sit at the same message/block granularity.

The view layer *tries* to soften pi's granularity: every `message_update` row
is marked `minor: true` (`events.ts:417-430`), and the app's
`ActivityStory` folds consecutive "Thinking" rows into one pulse
(`ActivityStory.swift:12-14`). But `wait` does not filter minor rows — its
`meaningfulOnly` filter excludes only `agent.system` and `heartbeat`
(`store.ts:68`, `store.ts:742`) — so every stored token delta is returned to a
`wait` caller. That is observation 1 ("a single `wait` call returned ~100 such
events covering roughly 3 seconds of work"): `waitForTasks` caps at 100 events
(`tasks.ts:122`), and at 80 events/s a 100-row response covers 1.2 s of
streaming. The summaries observed — `Thinking Start`, `Thinking: Let`, `Thinking: me`,
then ~40 consecutive `Toolcall Delta` rows with no detail — are exactly the
`piEvent` arms at `events.ts:417-429`: `thinking_start` humanizes to
"Thinking Start", `thinking_delta` with text becomes "Thinking: <token>", and
`toolcall_start/delta/end` fall through to `humanize(deltaType)` with **no
detail** because a streamed tool-argument token fragment is not row-worthy
content (`events.ts:425-429`).

## The silence: capture stop, not worker silence

Observation 2 (9–10 minutes of zero events while files change) is proved from
the code and the DB to be **Inter stopping storage**, not pi going quiet, not
pipe buffering, and not `wait` hiding events:

1. **The cap fires.** `MAX_EVENTS = 5_000` (`tasks.ts:25`); the handler checks
   `eventCount >= MAX_EVENTS` before storing (`tasks.ts:460-464`), appends one
   `events_truncated` row, and sets `eventCaptureStopped = true`. Every line
   from then on hits the early return at `tasks.ts:459` — no store, no
   `lastAgentEventAt` update, no marker per line.
2. **The DB shows it for all four runs.** Each pi task today stores exactly
   5,000 agent events, then an `events_truncated` row, then nothing:
   - `ec06750f`: 4,914 `message_update` + 86 other agent events = 5,000;
     truncated 63 s in; 11 m 44 s of total capture silence until `completed`.
   - `b4f8c111`: 4,954 + 46 = 5,000; truncated 64 s in; ~3 m 49 s silence.
   - `697ebff0`: truncated twice (both the original run and its resume), 9,784
     `message_update` rows across the two.
   - `e11fe938`: 4,982 + 18 = 5,000; truncated.
   The heartbeats keep arriving every 10 s for the whole run (they are appended
   by the broker-side interval at `tasks.ts:442-449`, not by the line handler),
   which is why the "silence" is punctuated by exactly one heartbeat per 10 s —
   and why `progress` keeps reporting. That is the observation-3 false stall:
   `silentMs` reached 663,263 → 703,469 (`silentMs >= 30_000` ⇒ `stalled`,
   `tasks.ts:447`) while the worker was editing files.
3. **The flood is the cause.** At ~80 events/s the 5,000 budget is gone in ~60
   seconds — before the run has done any real work. The trace therefore
   contains the run's thinking and first tools, then nothing until the terminal
   `completed` row. The worker is not stalled; *the capture is*.

What pi actually emitted during the silence cannot be read from Inter's side:
the dropped lines are never stored, and the raw stdout tail is not persisted
(`tasks.output` holds only the extracted final text, `tasks.ts:596-622`). pi's
own transcript (`~/.pi/agent/sessions/…`) would settle it, and it is outside
this run's read scope. It does not matter for the diagnosis: whatever pi
emitted, Inter had already decided not to store it.

## Capture limits on the path

| Limit | Where | What it protects | What is lost when it fires |
| --- | --- | --- | --- |
| 64 KB line cap (`MAX_EVENT_LINE`) | `tasks.ts:24`, check at `tasks.ts:467-478` | The event row and the parse path from a giant single line | Any event whose serialized line exceeds 64 KB. **First** oversized line per run is announced via `event_dropped` (with `bytes`/`limit`, `tasks.ts:471-474`); every later one is dropped **silently** (`tasks.ts:477-478`). On opencode these are large tool results (see below); on pi a `turn_end` tool-results echo (measured 77,564 B, `e11fe938`). |
| 5,000 event cap (`MAX_EVENTS`) | `tasks.ts:25`, check at `tasks.ts:460-464` | The `task_events` table from unbounded growth | **Everything** the worker emits after the 5,000th stored agent event: no rows, no `lastAgentEventAt` updates, so the trace freezes and `stalled` goes true. Announced once per run via `events_truncated` (`tasks.ts:461`). On pi: all tool execution after the first minute (measured: 4–12 min of work unrecorded per run). |
| 64 KB line buffer reset (`readStream` carry) | `tasks.ts:782` | The splitter from buffering an unbounded partial line | A line fragmented across pipe chunks that exceeds 64 KB mid-line is dropped before `onLine` ever runs — **no `event_dropped`, no `lastAgentEventAt` update**. Unlike the cap above, this one can produce a false `stalled` while capture is still on. |
| JSON parse failure | `tasks.ts:484-492` | The stream from one malformed line killing the run | The line, silently — and the `catch { return }` also skips the `lastAgentEventAt` update, so a provider printing non-JSON on stdout reads as stalled. |
| `compactPayload` | `tasks.ts:150-157` | Storage volume: pi repeats the whole message so far inside every delta (a 9 s run measured 827 KB, 91 % repeats); the assembled message arrives on `message_end` anyway | The cumulative `message` field of each `message_update` — the part the trace never renders. Not a loss in practice. |
| 10 MB stdout tail (`MAX_OUTPUT`) | `tasks.ts:26`, `tasks.ts:777`, `tail` at `tasks.ts:789-791` | Memory for `finalText` | The head of stdout — irrelevant to events; only affects the extracted final text on very long runs. |
| 64 KB stderr cap | `tasks.ts:545` | Memory | Head of stderr; stderr is never parsed into events, so nothing event-shaped is lost. |
| `wait` event truncation | `tasks.ts:122` (`slice(0, 100)`), summaries at `tasks.ts:132` (500 chars), query limit 101 at `store.ts:734-758` | Response size | Events beyond the newest 100 (or beyond the cursor); the oldest ones in a big run. Nothing about *capture*, only about display. |
| Events API page cap | `cli.ts:230-231` (5,000 rows) | `/api/tasks/:id/events` response size | Events beyond the newest 5,000 per call (`hasMore` is returned). |
| Heartbeat noise filter (`NOISE_EVENTS`) | `store.ts:68`, applied at `store.ts:742`, `store.ts:768` | The `wait` cursor and event list from heartbeats | Heartbeats are still stored (every 10 s per run) and are what `progress` reads (`store.ts:775-806`); they just don't advance the cursor. |

The 64 KB and 5,000 caps are the two that matter; everything below them is
either display-side or designed loss.

## What the recurring 99 KB dropped event actually is (opencode)

Identified from opencode's own database, which is outside Inter's capture path
and was not affected by the drop:

- Task `477bd901` (opencode, 2026-08-04): `event_dropped` at `00:29:05.032`,
  101,068 B. In `opencode.db`, part `prt_fca2c8bdf` — `type: "tool",
  tool: "read"`, `state.output` = the full content of
  `swift/Sources/TaskDetailView.swift` — was created at `00:29:04.863`
  (169 ms before the drop) and stores 100,842 B. Dropped line = stored part +
  ~226 B of stream envelope.
- Task `faae14e6` (opencode): dropped 83,427 B; its largest part is a `read`
  of 83,201 B → 83,201 + 226 = 83,427. Exact.
- The byte counts that repeat across runs (107,664 ×2, 79,879 ×3) are the same
  big file read again at the same point of the same-shaped task.

So the recurring line is the stream event that carries the **first large tool
result — a file `read` whose full content is echoed in the part** — not
something structural in session capture. It appears "right after session
capture" only because the first tool call of these runs is a big file read. The
comment at `tasks.ts:465-466` already names the class ("a large file read
echoed back as a tool result"); what the comment cannot say is which line — the
`event_dropped` payload stores only `bytes` and `limit`, and the line itself is
gone. Note that only the *first* oversized line per run is announced; every
other big tool result (every later large read, any big `bash` output) is
dropped with no marker at all.

The same class on pi: in `e11fe938`, the 77,564 B drop sits between the
toolResult `message_end` and the next `turn_start` — the `turn_end` echoing
both tool results. (Inferred from stream position, not from the line itself.)

## `stalled` / `silentMs`: what it actually measures

`progress.stalled` is a statement about **stored agent events**, not about the
worker. The heartbeat computes `silentMs = Date.now() − lastAgentEventAt`
(`tasks.ts:443`) and flags `stalled: silentMs >= 30_000` (`tasks.ts:447`).
`lastAgentEventAt` is advanced in exactly two places — the oversized-line branch
(`tasks.ts:468`) and the post-parse success path (`tasks.ts:499`). Anything
that stops lines reaching that path makes the worker look stalled:

- capture stop (`tasks.ts:459`) — the observed pi case, 11 minutes of false
  `stalled: true` on a run that completed normally;
- the `readStream` carry reset (`tasks.ts:782`) and the JSON parse failure
  (`tasks.ts:490-491`), both of which skip the clock update;
- genuine worker silence.

For the signal to be trustworthy across providers it needs a liveness source
independent of event flow: pipe-read activity (any bytes from the child, in
`readStream`) or the child process itself (`kill(pid, 0)`), with "no stored
agent events" reported as exactly that, not as "stalled".

## Recommendation

Two changes, both at the capture layer in `tasks.ts`; nothing in the view
layer, and nothing in `events.ts` beyond what falls out.

1. **Coalesce pi's `message_update` deltas before storage.** In the stdout
   handler (or a `pi`-branch helper called from it), accumulate
   `text_delta`/`thinking_delta` fragments into a per-run buffer keyed by
   block; store one event per block boundary (`thinking_end`/`text_end`/
   `toolcall_end`) or, for a block that never ends, flush on a ~1 s timer or on
   the next non-delta line. The row carries the block's assembled text (the
   trace already renders it as one "Thinking"/"Agent message" line), and a
   token count in the presentation if counts are wanted. `toolcall_*` deltas
   need no rows at all — the `tool_execution_start/end` pair already is the
   call — so a `toolcall_start` can record the call and deltas can be dropped.
   This is coalescing at capture, not at the view: the storage flood, the
   5,000-event burn, and the `wait` token wall all disappear together. The
   debug sweep already flagged the same target ("pi adapter — coalesce token
   deltas into step-level events", `inter-debug-2026-08-03.md:94-101,122`).
2. **Make liveness a pipe signal.** Track raw bytes from the child (cheap in
   `readStream`) or probe the child process, and derive `stalled` from that.
   Fix the `lastAgentEventAt` gaps in the parse-failure and carry-reset paths
   as part of it, or drop the heartbeat clock entirely in favour of the raw
   signal.

Keep the two caps as safety valves, but they should never fire on a healthy
pi run; with coalescing, a full day of pi work is a few hundred rows instead
of a few thousand per minute.

**Consequences.** SwiftUI trace: rows become readable and, critically, the
trace keeps moving for the whole run instead of freezing at the 5,000th token
(`ActivityStory`'s existing Thinking-pulse folding keeps working on the
coalesced blocks). `wait` callers: a 100-event response covers the run's actual
steps instead of 1.2 seconds of thinking; `stalled` stops lying. The event
table stops growing at ~80 rows/s per pi task, which also relieves the
`/api/state`-sized problems the hang document measured
(`inter-hang-2026-08-04.md:141-153`). The one behavioural change to check: the
trace's per-token granularity goes away — nothing today renders those rows as
anything but noise, so this is the intended trade.

## Unverified

- **What pi emitted during the 9–12 minute silences.** Inter's side proves it
  stopped storing; pi's own transcript (`~/.pi/agent/sessions/`) is outside
  this run's read scope. Reading the transcript for a truncated run would show
  the tool events Inter skipped.
- **The exact wire type of the dropped pi line** in `e11fe938`. Position
  (between toolResult `message_end` and `turn_start`) says `turn_end` carrying
  `toolResults`; the line itself is not recoverable.
- **The exact opencode stream event type** that carried the dropped part
  (`message.part.updated` vs `message.part.finished`). The content is proven
  (the `read` part); the envelope name is not recorded anywhere Inter keeps
  data. A live `opencode run --format json` probe with a first read of a
  >64 KB file would confirm it in seconds.
- **Installed pi version.** `pi --version` prints nothing in this environment
  (and `docs/pi.md:164-172` notes the version self-updates). The
  `compactPayload` comment's 827 KB measurement (`tasks.ts:145-149`) and
  `docs/pi.md:116-118` date the cumulative-message behaviour to 0.82.x; whether
  today's runs were on 0.82.x or 0.83.x changes only whether `message_update`
  lines were themselves at risk of the 64 KB cap (they were not — no
  `event_dropped` fired during the floods of `ec06750f`/`b4f8c111`).
- **Whether any oversized lines were dropped silently** after the one
  `event_dropped` in each run. The `oversizedLine` flag (`tasks.ts:469`)
  guarantees the second and later oversized lines are invisible; in runs where
  the first big file read is followed by other big reads, those rows are gone
  without a marker. Counting them requires replaying the worker's raw stdout.
