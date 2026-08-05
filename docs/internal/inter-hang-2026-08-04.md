# Inter 0.3.0 — 613 s main-thread hang, 10.66 GB footprint (2026-08-04 01:15)

Diagnosis written against `swift/Sources/` at `42236be`, with live scale numbers
read from the running broker's HTTP API. No source was edited; no build was run.

## TL;DR

The hang is one SwiftUI layout transaction that can never reach a fixed point:
the activity trace renders **every** event of the open task in a `LazyVStack`
(`swift/Sources/TaskDetailView.swift:319`) whose laziness is defeated by
`.defaultScrollAnchor(.bottom)` (`swift/Sources/TaskDetailView.swift:102`), and
the 2-second `/api/state` poll (`swift/Sources/ProfileStore.swift:17`) re-renders
that whole pane from scratch every 2 s — `ActivityStory.compose(events)` is
called inside `body` (`swift/Sources/TaskDetailView.swift:318`) and its result
types are not `Equatable` (`swift/Sources/ActivityStory.swift:280`, `:350`), so
nothing can be skipped. Traces in this DB reach **5,079 events / 5.0 MB**, so one
measurement pass takes longer than the 2 s interval that invalidates it, and the
graph loops forever at 100 % CPU. Confidence: **high** for the mechanism,
**medium** for which of the two coupled defects dominates the 10.66 GB.
One-line fix: cap the rendered trace at `swift/Sources/TaskDetailView.swift:319`
(render the last N blocks behind a "show earlier" control) — that bounds
realization whatever the scroll anchor asks for.

Secondary, and independently worth fixing: `/api/state` ships **1,809,025 bytes
every 2 s** (measured), 89 % of it `prompt` + `shippedPrompt` + `output`, and
`ProfileStore.swift:25` asks for `archived=include` so the payload never shrinks.
`10.66 GB ÷ 1.81 MB ≈ 5,890 polls ≈ 3.3 h` — the same order as the process's
3.04 h uptime. This is the only defect that is *linear in uptime*, which is what
the ~3 h delay wants.

## Evidence

**What the counters establish.**

- `Num threads: 6`, 4 idle work-queue threads omitted → 2 live threads. Not a
  lock, not I/O contention, not a thread explosion.
- `CPU Time: 1.005s over the 1.005s sample window on thread 0` → the main thread
  is executing, not blocked. A deadlock would show 0 CPU.
- All 11 samples share the prefix `NSApplication.run → _CFRunLoopDoObservers →
  NSRunLoop.flushObservers() → NSHostingView.beginTransaction() → Update.ensure
  → GraphHost.flushTransactions() → GraphHost.runTransaction() →
  AG::Subgraph::update()`. One SwiftUI transaction, entered from the run-loop
  observer, never returning. `flushTransactions` iterates until the graph settles;
  it never settles.
- `Footprint: 10.66 GB` with `Memory size: 24 GB` and Low Power Mode on. Nothing
  in the app's own data model is 10 GB (see **Data scale**), so this is
  view-graph residency plus per-pass allocation that is never reclaimed — the
  main run loop is wedged, so no autorelease pool drains and no free memory is
  returned for the whole 613 s.

**What the three tails establish.** They are not three bugs; they are three
cross-sections of the same pass over the same list.

- **Tail B is the diagnosis.** `ScrollViewUtilities.sizeThatFits →
  LazyLayoutComputer.Engine.sizeThatFits → LazyStack.sizeThatFits →
  LazyStack.measureEstimates → _LazyLayout_Subviews.apply → ForEachList.applyNodes
  → … → BaseViewList.applyNodes`. A lazy stack is being asked for its *total*
  size, so it walks the entire `ForEach` view list and measures every row. The
  only `ScrollView`-wrapped `LazyVStack` on the activity path is
  `TaskDetailView.swift:319` inside the `ScrollView` at `TaskDetailView.swift:82`.
  The thing that asks a `ScrollView` for its full content size is
  `.defaultScrollAnchor(.bottom)` at `TaskDetailView.swift:102` — you cannot
  anchor to the bottom without knowing where the bottom is. The comment at
  `:97-101` says this anchor was chosen *because* the old sentinel overshot
  unmeasured rows; the fix traded a blank panel for a full measurement.
  `_FlexFrameLayout.sizeThatFits` above it is the
  `.frame(maxWidth: 980 * uiScale)` / `.frame(maxWidth: .infinity)` pair at
  `TaskDetailView.swift:86-88`; `NavigationStackLayout` is the
  `NavigationSplitView` detail column at `ContentView.swift:127`. That the stack
  goes through `NavigationStackLayout` and a lazy stack — and *not* through
  `List` — rules out the sidebar (`ContentView.swift:28` is a plain `List`).
- **`ModifiedViewList.applyNodes ×5` names the row.** `ActivityChapterCard`
  applies exactly five modifiers to its own body —
  `.padding(.vertical, 4)`, `.padding(.horizontal, 14)`,
  `.frame(maxWidth: .infinity, alignment: .leading)`, `.background(…, in:)`,
  `.opacity(…)` — at `TaskDetailView.swift:556-560`. A view's body flattens into
  its parent's view list, so those five become five list-transform layers per
  node, re-applied on every `applyNodes` walk.
- **Tail A is the per-row cost.** `_HStackLayout.explicitAlignment` recursing
  five times is the nested-stack chain
  `LazyVStack(:319) → ActivityChapterCard VStack(:543) → ActivityWorkRow
  VStack(:570) → HStack(alignment: .firstTextBaseline)(:571) → quoteContent
  HStack(alignment: .top)(:610) / inlineContent HStack(:651) → chips`.
  `.firstTextBaseline` is an explicit alignment guide: the outer stack must ask
  every child for its first text baseline, and a nested stack can only answer by
  resolving its own children's baselines. `.layoutPriority(1)` at
  `TaskDetailView.swift:578` adds a second width-negotiation pass on top. Two
  explicit guides, five stack levels, per row, ~5,000 rows.
- **Tail C is bookkeeping, not a cause.** There is no `.transition(` anywhere in
  `swift/Sources/` (grepped). `ViewListTransition.updateValue →
  ViewList.traits.getter` is what SwiftUI installs on a *dynamic* view list whose
  identity set is being re-derived under an animation transaction — which is
  exactly `ForEach(story.blocks)` at `TaskDetailView.swift:320` rebuilt from a
  fresh `compose()` every pass, with `withAnimation` in scope from
  `TaskDetailView.swift:1071`. It confirms the list is churning; it does not add
  an independent defect.
- The remaining samples (`PlatformViewChild.updateValue`,
  `DynamicLayoutViewChildGeometry.updateValue`, `UnaryChildGeometry`,
  `RootGeometry`) are all the same transaction. `PlatformViewChild` is an
  AppKit-backed child — the `.textSelection(.enabled)` Texts at
  `TaskDetailView.swift:618`, `:667`, `:723` and the `Button` inside `IconButton`
  (`DesignSystem.swift:286-309`), one per event row.

**What the recent commits do *not* explain.** The process forked at
`10933s` before 01:15, i.e. ~22:13 on 08-03. `42236be` was authored
`2026-08-04 01:55:18 +0100` — 40 minutes *after* the hang — and `b40ffaf` at
`01:06:58`, also after the fork. So `ScrollJumpControl`/`jumpMarker`
(`TaskDetailView.swift:345`, `:416-433`) and `ActivityHandoffCard`
(`:764-824`) were **not in the hung binary**. Verified by diffing
`42236be~1:swift/Sources/TaskDetailView.swift`: the hung binary had the same
`ScrollView { sectionContent }`, the same
`.defaultScrollAnchor(followsTail && section == .activity ? .bottom : .top)`,
and the same `.task(id:)` event loop. Both prime suspects are exonerated;
everything cited below predates them (`defaultScrollAnchor` came in `bbb700a`,
2026-08-03 19:55; the `LazyVStack` in `9632735`, 2026-07-29).

## Data scale

Read live from `http://127.0.0.1:7331` (the SQLite file at `~/.inter/inter.db`
is outside this run's read scope — `sqlite3` returns `authorization denied` —
so these come from the same rows via the broker's own API).

**`GET /api/state?archived=include` — exactly what `ProfileStore.refresh()` requests
(`ProfileStore.swift:24-26`):**

| field | value |
| --- | --- |
| payload | **1,809,025 bytes** |
| tasks | 200 (150 completed, 20 cancelled, 16 failed, 11 blocked, 3 running) |
| `prompt` total / max | 521,457 / 34,636 chars |
| `shippedPrompt` total / max | 869,449 chars — the single largest field |
| `output` total / max | 223,278 / 12,141 chars |
| `attempts` total | 13,426 chars |
| text as share of payload | **1,614,184 / 1,809,025 = 89.2 %** |

`shippedPrompt` is the biggest contributor and `TaskSnapshot`
(`Models.swift:81-140`) **does not even declare it** — 869 KB is parsed and
discarded on every poll. `archived=include` (`ProfileStore.swift:25`) fetches all
200 tasks and `ContentView.swift:171` throws the archived ones away client-side.

**Per-task event traces, all 200 tasks paged through
`GET /api/tasks/:id/events`:**

| field | value |
| --- | --- |
| total events | 44,630 |
| total `rawText` | 48,938,434 chars (48.9 MB) |
| max events on one task | **5,079** (`6e88b5cd`, 3.31 MB) — the broker caps capture at 5,000 (`src/cli.ts:163-164`), so five tasks sit at ~5,02x |
| largest single trace payload | **5,019,273 bytes** (`82ade75a`, 998 events, 4.37 MB `rawText`) |
| max `rawText` on one event | 54,499 chars |

So an open trace is 1,000–5,000 rows and 2–5 MB, and `rawText` averages ~4.4 KB
per event.

**Arithmetic to 10.66 GB.**

- Poll path: `10.66 GB ÷ 1,809,025 B = 5,890 polls`. At the 2 s cadence
  (`ProfileStore.swift:17`, plus request time, plus an extra `refresh()` after
  every mutation) that is ≈ 3.3 h against a measured 3.04 h uptime — an ~8 %
  gap. Take the *order* seriously, not the coincidence: task count grew over
  those 3 h, so the average payload was smaller than today's 1.81 MB and true
  cumulative bytes are somewhat below 9.9 GB. Still the only mechanism that
  scales linearly with uptime.
- Trace path: ~5,000 realized rows × (~8 SwiftUI view nodes + one AppKit-backed
  selectable-text region + one non-skippable `Button`) ≈ 40,000 nodes and ~5,000
  platform views. AppKit text bridging runs tens of KB apiece, so this is
  hundreds of MB to low GB resident — plus a fresh `compose()` result per pass
  (`foldActions` copies ~5,000 structs with retained strings,
  `ActivityStory.swift:174-196`), which at ~1,800 passes/hour is GB-scale churn
  that only frees when the run loop turns. It never turns.
- Neither number is measured, only derived. A heap snapshot is the only way to
  split them; see **Repro**.

## Candidates

### 1. Activity trace fully realized and fully re-composed on every poll — most likely

`swift/Sources/TaskDetailView.swift:319` (`LazyVStack`), `:102`
(`.defaultScrollAnchor(.bottom)`), `:318` (`compose` in `body`);
`swift/Sources/ActivityStory.swift:280`, `:350` (payloads not `Equatable`);
`swift/Sources/ProfileStore.swift:17` (the 2 s invalidator);
`swift/Sources/ContentView.swift:133` + `TaskDetailView.swift:34` (the closure
that blocks skipping).

Mechanism, in order:

1. `.defaultScrollAnchor(.bottom)` asks the `ScrollView` for total content
   height → the `LazyVStack` measures **every** block. Laziness is off.
2. `ActivityStory.compose(events)` runs inside `body` (`:318`), so every render
   re-folds and re-buckets all 5,000 events and allocates a whole new
   `[ActivityBlock]`.
3. `ActivityBlock` (`ActivityStory.swift:280`) and `ChapterRow` (`:350`) declare
   `Identifiable` but not `Equatable`, and `HandoffRun`/`HandoffBoundary`
   (`:334`, `:340`) declare neither. `ForEach` diffs ids fine, but SwiftUI cannot
   prove a card's `rows: [ChapterRow]` is unchanged, so **every** chapter card
   re-renders and re-measures.
4. `TaskDetail` holds `let setArchived: (TaskSnapshot, Bool) -> Void`
   (`TaskDetailView.swift:34`, passed at `ContentView.swift:133`). A closure is
   not `Equatable`, so SwiftUI can never skip `TaskDetail.body` — every poll
   re-enters it even when the `TaskSnapshot` is byte-identical.
5. `ProfileStore.tasks = state.tasks` (`ProfileStore.swift:30`) fires every 2 s
   on an `@Observable`, invalidating `ContentView` → `TaskDetail` → steps 1-3.
6. One pass over 5,000 rows, each with five stack levels and two explicit
   alignment guides (Tail A) and five list-transform layers (Tail B), takes
   longer than 2 s. `GraphHost.flushTransactions` loops until the graph settles;
   a new invalidation lands before it can. The transaction never returns.

Explains a CPU-bound single transaction: **yes** — directly, and all three tails
sit inside it. Explains 10.66 GB: **partly** — realized platform views plus
per-pass `compose()` allocation with no run-loop drain; order-of-magnitude, not
measured. Explains ~3 h: **yes** — a task has to reach the broker's 5,000-event
cap and be left open in the Activity tab (which is the default section,
`TaskDetailView.swift:37`).

The 613 s is not a duration this predicts — it predicts *unbounded*. 613 s is
just when the sample was taken.

### 2. `/api/state` ships full task rows every 2 s — the memory driver and the trigger

`swift/Sources/ProfileStore.swift:22-33` and `src/cli.ts:91-107`.

`src/cli.ts:95-98` maps every task through unchanged, so `prompt`,
`shippedPrompt`, `output` and `attempts` all ship. Measured 1,809,025 B per poll,
89 % of it text. `ProfileStore.swift:25` requests `archived=include`, so the
payload grows monotonically with the task table and never shrinks. This is the
only candidate that is linear in uptime, and the arithmetic
(5,890 polls ≈ 3.3 h) lands on the observed footprint.

It is also candidate 1's clock: without a 2 s invalidation there would be one
slow measurement pass, not an endless loop.

Explains a CPU-bound layout transaction: **no**, not on its own — a JSON decode
would show `JSONDecoder`/`URLSession` frames, and none appear. Explains 10.66 GB:
**yes**, by arithmetic. Explains ~3 h: **yes**, best of the three.

Note also `ProfileStore.swift:26` uses `URLSession.shared` with default cache
policy, so `URLCache.shared` heuristically caches a 1.81 MB uncontrolled-response
GET 1,800 times an hour. Too small a cache to hold 10 GB in memory, but it is
pure waste.

### 3. Hot event-poll loop on non-`running`, non-terminal tasks — real bug, timing unconfirmed

`swift/Sources/TaskDetailView.swift:113-119` and `src/cli.ts:156`.

```
while !Task.isCancelled {
    await loadEvents()
    let live = …
    if TaskState(live).isTerminal, !loading { break }
    if loadFailed { sleep 1s }
    else if eventCursor == 0 { sleep 500ms }
}
```

There is no sleep when `eventCursor > 0` and the load succeeded — the only
throttle is the server's long poll. But `src/cli.ts:156` gates that on
`task.state === "running"`. For `blocked`, `needs_input` or `queued` the server
returns instantly, so the loop spins on the main actor as fast as HTTP allows,
and each iteration runs `Set(events.map(\.id))` plus `events.sort` over ~5,000
elements (`TaskDetailView.swift:406-410`) and reassigns `@State events`, storming
SwiftUI with invalidations. 11 of 200 tasks are `blocked` right now, so this state
is common and long-lived.

Explains CPU pegging and a never-converging transaction: **yes**. Explains
10.66 GB: **partly**, via unbounded invalidation churn. Explains ~3 h: **weakly**
— it would hang within seconds of opening such a task, not after 3 h.

**Why it is ranked third, honestly:** the hang began at ~01:04:48
(01:15 minus 612 s). Every task that existed before then is now `completed` or
`cancelled` — both terminal, both break the loop at `:115`. The one task alive in
that window, `dab6153a` (created 01:04:29, cancelled 01:05:12), was `queued` and
would have qualified — but I cannot reconstruct state history from the current DB,
so this stays plausible-not-proven. Fix it anyway; it is a one-line bug that will
hang the app on its own.

### Rejected: state mutated during body evaluation

No `body` in `swift/Sources/` writes state. `ActivityStory.compose` is pure
(`ActivityStory.swift:21-26`). Every mutation is in `.task`, a button action, or
an `async` closure. Nothing to re-enter.

### Rejected: unstable `ForEach` identity on the activity path

`ForEach(story.blocks)` keys on `ActivityBlock.id`
(`ActivityStory.swift:287-295`), which resolves to DB event ids — stable across
polls. `ForEach(Array(rows.enumerated()), id: \.element.id)`
(`TaskDetailView.swift:544`) keys on the element, not the index.
`.chapter(id:)` always takes `chapter[0].id` and `chapter[0]` is always
`.work` (`ActivityStory.swift:54` only appends `.reasoning` to a non-empty
chapter), so chapter ids cannot collide with signal/receipt ids. `.handoff`
returning `0` (`:293`) is safe because `composeWithHandoffs` emits exactly one
(`:134-137`).

Two index-keyed `ForEach`es do exist and will churn if content is ever prepended
— `TaskDetailView.swift:794` (`id: \.offset` over `earlierRuns`) and
`ReviewContent.swift:249` (`id: \.offset` over markdown blocks) — but neither was
in the hung binary's hot path, and neither reorders in practice. Nits, not this
bug.

### Not the hang, but on the same surface

`ReviewContentView.body` (`ReviewContent.swift:234-241`) calls
`ReviewContent(source)` on **every** render, which at `:9-13` attempts a full
`JSONDecoder().decode(JSONValue.self, …)` — an `indirect enum` recursive boxed
tree (`:18-41`) — over the whole source, then falls back to
`MarkdownParser.parse` (`:90`), and each code fence runs
`CodeStyle.highlighted` → `Array(source)` (`SyntaxHighlight.swift:70`), where
Swift `Character` is 16 bytes. With `task.output` reaching 12,141 chars and
`rawText` 54,499, that is a full re-parse and re-highlight every 2 s for whichever
of Request/Response/expanded-raw is on screen. It is not in the sampled stacks
(section defaults to `.activity`, `TaskDetailView.swift:37`), so it is not this
hang — but it is the same class of defect and one tab click away.
`JSONValue.children` (`ReviewContent.swift:66-75`) re-sorts and re-copies the
child array on each of its three call sites per row (`:416`, `:433`, `:442`).

## Recommended fix

### Stops the hang

1. **Bound the rendered trace.** `swift/Sources/TaskDetailView.swift:319` — render
   only the last N blocks (300 is generous for a screenful plus scroll headroom)
   with a "show earlier activity" control for the rest, mirroring the existing
   technical-events toggle at `:323-336`. This is the one change that holds
   whatever the anchor, the poll, or `Equatable` do, and it bounds the platform-view
   count that drives the footprint.
2. **Hoist the composition out of `body`.** `swift/Sources/TaskDetailView.swift:318`
   — move `ActivityStory.compose(events)` into `@State private var story` and
   recompute it in `appendEvents` (`:406-410`), the only place `events` changes.
   Removes O(events) work and a full `[ActivityBlock]` allocation from every
   render pass.
3. **Let SwiftUI skip unchanged cards.** `swift/Sources/ActivityStory.swift:280`
   and `:350` — add `Equatable` to `ActivityBlock` and `ChapterRow`
   (`TaskEventSnapshot` and `ReasoningPulse` are already `Hashable`, so this is
   synthesised), and to `HandoffRun` (`:334`) and `HandoffBoundary` (`:340`) plus
   `Hop` (`:302`). Turns "re-measure every chapter" into "re-measure the chapter
   that changed".
4. **Stop the spin loop.** `swift/Sources/TaskDetailView.swift:117-118` — make the
   sleep unconditional (`else { try? await Task.sleep(for: .milliseconds(500)) }`)
   instead of `else if eventCursor == 0`. Optionally also widen the server-side
   long poll at `src/cli.ts:156` from `task.state === "running"` to any
   non-terminal state, so a `blocked` or `needs_input` task is followed rather
   than polled.
5. **Shrink the poll.** `swift/Sources/ProfileStore.swift:25` — request
   `archived=active` unless archived tasks are being shown, and `src/cli.ts:95-98`
   — return summaries without `prompt`, `shippedPrompt`, `output` or `attempts`,
   with `TaskDetail` fetching the one open task's detail on demand. This is the
   fix already recorded as *known sink #1* in the `response-payload-budget`
   project memory, and `TaskSummary` already exists on the broker side.
   `shippedPrompt` alone is 869,449 of the 1,809,025 bytes and
   `Models.swift:81-140` does not even decode it.

(1) and (5) are the two that matter. (2)–(4) stop it recurring under a different
shape.

### Follow-ups

- `swift/Sources/TaskDetailView.swift:102` — once the trace is bounded, revisit
  `.defaultScrollAnchor(.bottom)`. The comment at `:97-101` chose it because the
  sentinel overshot unmeasured rows; with a bounded row count
  `proxy.scrollTo("bottom")` after the first load works, and does not demand full
  content height on every pass.
- `swift/Sources/TaskDetailView.swift:618`, `:667`, `:723` — `.textSelection(.enabled)`
  on every event row bridges an AppKit text region per row. Move it into the
  expansion (`EventExpansionView`, `EventExpansion.swift:54`), where the reader
  actually selects text.
- `swift/Sources/TaskDetailView.swift:556-560` — five modifiers on
  `ActivityChapterCard`'s body become five `ModifiedViewList` layers per node.
  Fold the two `.padding` calls into one and drop `.opacity(muted ? 0.72 : 1)`
  in favour of a `foregroundStyle` on the muted branch.
- `swift/Sources/TaskDetailView.swift:571` + `:610`/`:651` — replace the nested
  `.firstTextBaseline` / `.top` stack pair with a single stack, or drop the
  explicit guide to the default `.center`. Tail A is entirely this.
- `swift/Sources/DesignSystem.swift:288` — `var tint: AnyShapeStyle` makes
  `IconButton` permanently non-`Equatable`, so every one of ~5,000 row buttons
  re-renders on every pass. A small `enum Tint` would let SwiftUI skip them.
- `swift/Sources/ProfileStore.swift:26` — set
  `request.cachePolicy = .reloadIgnoringLocalCacheData`; there is no reason for
  `URLCache.shared` to see a 1.81 MB poll response 1,800 times an hour.
- `swift/Sources/ReviewContent.swift:234-241` — memoise `ReviewContent(source)`
  behind the source string instead of re-parsing and re-highlighting on every
  render.
- `swift/Sources/ContentView.swift:508` — `.help(task.hoverText)` falls back to
  the entire prompt (`Models.swift:133-139`), up to 34,636 chars, held in the view
  graph for all 200 sidebar rows. `42236be` improved this by preferring `tldr`;
  the fallback still ships the whole prompt.
- `src/cli.ts` events route — responses embed raw control characters inside JSON
  strings (`jq` rejects the body with `Invalid string: control characters from
  U+0000 through U+001F must be escaped`; Python's stricter-by-default `json`
  accepts it, and Foundation's `JSONDecoder` does too). Worth confirming
  separately; it is not part of this hang.

## Repro / confirmation

A live repro exists in this DB — no seeding needed:

1. Launch Inter and open task `6e88b5cd-c2fe-46e9-acc2-2cc86aa16601` — 5,079
   events, 3.31 MB. Land on the **Activity** tab (the default,
   `TaskDetailView.swift:37`). `82ade75a-a0c0-4a8d-8ff1-06f2057ddd1c` is the
   heavier payload (5.02 MB / 998 events) if you want to separate "many rows"
   from "large rows".
2. Attach Instruments with the **SwiftUI** template alongside **Time Profiler**
   and **Allocations**. Predictions, in falsifiable form:
   - "View body" count for `ActivityChapterCard` climbs by the full chapter count
     every ~2 s, in lockstep with the poll → confirms steps 3-5 of candidate 1.
     Comment out `tasks = state.tasks` at `ProfileStore.swift:30` and the churn
     should stop dead; that is the cleanest single-variable test.
   - Time Profiler concentrates in `explicitAlignment` and `measureEstimates`,
     matching Tails A and B.
   - Allocations persistent bytes grow monotonically with poll count. Note the
     live-bytes figure before and after fix (5): if it drops roughly 10× the
     footprint was the poll, if it barely moves it was the realized rows.
3. To isolate the anchor specifically: change
   `TaskDetailView.swift:102` to a constant `.top` and reopen the same task.
   If the wedge disappears while the row count is unchanged, laziness was the
   whole story.
4. `footprint -p $(pgrep Inter)` sampled every 60 s over an hour gives the
   uptime-linear slope that candidate 2 predicts (~1.81 MB × 30 polls/min ≈
   54 MB/min if nothing is reclaimed).

Honest limit: **the original hang is not reproduced until one of these opens
wedges the app.** I have the mechanism and the scale, not a captured re-hang.
Candidate 3 in particular cannot be confirmed from the current DB at all — its
trigger state is not recoverable from task history.

## Open questions

- **Which task was open at 01:04:48?** Not recoverable. Every task alive before
  the hang began is now terminal. This is what keeps candidate 3 unproven and
  keeps candidate 1's "5,000 rows were realized" an inference from the stack
  shape rather than a fact about that moment.
- **How is the 10.66 GB actually split** between realized platform views,
  per-pass `compose()` garbage that never drained, and 3 h of poll payloads? Only
  a heap snapshot answers this. The arithmetic favours the poll; the stacks favour
  the view graph; the fix list covers both, which is why I did not force a choice.
- **`LazyVStackLayout → LazyHStackLayout` in Tail B.** There is no `LazyHStack`
  anywhere in `swift/Sources/` (grepped). Most likely inlined generic
  specialisations of the shared `LazyStack` template resolving to both symbol
  names in the sampler, but I cannot verify SwiftUI internals from here, so I did
  not build any argument on it.
- **Was the trace ever actually 5,000 rows on screen,** or does
  `measureEstimates` walk the list without realizing every row's platform views?
  If the latter, the CPU story stands but the memory story leans harder on
  candidate 2.
- **Does the SQLite store hold more than the API exposes?** All scale numbers came
  through the broker's HTTP API because `~/.inter/inter.db` is outside this run's
  read scope. Event rows older than the broker's 5,000-per-task capture limit, and
  any archived-and-purged rows, would not appear in my counts.
