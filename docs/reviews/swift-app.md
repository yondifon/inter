# SwiftUI app review

Reviewed against `swift/Sources/*`, `swift/Tests/*`, `Package.swift`, `Makefile`, cross-checked against
`src/types.ts`, `src/public-task.ts`, `src/events.ts`, `src/cli.ts`, `src/tasks.ts`, `src/store.ts`.
No build run (sandbox); no source file modified.

Line anchors re-verified 2026-08-04 against `TaskDetailView.swift` at **1091** lines, `ActivityStory.swift`
at **406**, `Models.swift` at **224**. Those three files — plus `src/cli.ts`, `src/events.ts`,
`src/tasks.ts`, `src/public-task.ts`, `src/types.ts` — changed while the review was being written (the
`effort` chip, then `ActivityHandoffCard` and `Hop`/`HandoffRun`). Every citation below points at the
current tree; if those line counts no longer match, expect the anchors to have drifted again. All other
Swift sources are unchanged from first read.

## Verdict

The pure logic in this app is genuinely good: `ActivityStory`, `TaskOrganizer`, `FileChange`,
`CommandOutput`, `SyntaxHighlighter` and `MarkdownParser` are side-effect-free, densely commented with
*why* rather than *what*, and covered by 70 tests that read like specifications. The problem is the
boundary between that logic and the views. `TaskDetailView.swift` is four files and eighteen types in
one, and it invokes the expensive pure functions — markdown parsing, trace composition, JSON payload
parsing, LCS diffing — from inside `body`, so every 2-second poll re-parses the whole prompt and
recomposes the whole trace. A second cluster of defects comes from state that is modelled once too
often: three booleans encoding a four-state load, cancel/resume preconditions written twice in two
files, secret masking implemented on both sides of the wire with different rules.

The single biggest structural problem is that `TaskDetail` is simultaneously an HTTP paging client, a
trace renderer, a task-action controller and a layout host (`TaskDetailView.swift:31-389`). Splitting the
trace views out is a pure file move with no behavior risk and pays for itself immediately. Two defects
are worth fixing before any refactor: the JSONC sanitizer can silently corrupt a user's
`~/.claude.json`, and the activity trace stops updating after an in-app Resume.

## Findings

### 1. `sanitizeJSONC` strips commas inside string values, corrupting the config it rewrites — Critical
**Where:** `swift/Sources/MCPConfigInjector.swift:101-127` (the regex at `:126`)
**Problem:** The function walks the text with a string-aware loop to remove `//` comments, then throws
that awareness away and applies `replacingOccurrences(of: #",\s*([}\]])"#, ..., options: .regularExpression)`
to the *entire* document, including inside string literals. `\s` matches newlines, so any string value
containing a comma followed by whitespace and then `}` or `]` loses the comma. The mangled text is then
parsed and written back over the real file by `installJSON` → `backupAndWrite` (`:71-99`).
**Why it matters:** The targets are `~/.claude.json`, `~/.config/opencode/opencode.json` and
`~/.gemini/config/mcp_config.json` — files the app does not own, and `~/.claude.json` holds arbitrary
user prose (project history, saved prompts, CLI args). A single toolbar click can quietly rewrite
someone's config. A `.bak` is left behind, but nothing tells the user to look at it.
**Failure case:** `~/.claude.json` containing `"description": "pass a, } to the flag"` → after
sanitizing, `"pass a} to the flag"`. Same for `{"args": ["--set=x, ]"]}`.
**Fix:** Do the trailing-comma removal inside the existing loop, where `inString` is already tracked —
when not in a string and the character is `,`, look ahead past whitespace and drop the comma only if the
next non-space character is `}` or `]`. Delete the regex. Add a test with a string value containing
`", }"` and one with a real trailing comma; both are pure-function tests on `sanitizeJSONC`.
Secondary: `installJSON` re-serializes the whole file through `JSONSerialization` with `.sortedKeys`,
which reorders every key and round-trips numbers through `NSNumber`. That is a lossy rewrite of a file
the app was only asked to add one key to; worth a note in the results sheet at minimum.
**Risk:** RISKY — core behavior (`MCPConfigInjector`). The fix is local to one private function and
testable without touching the install flow.
**Effort:** S

### 2. Activity trace freezes after an in-app Resume, and after a question is answered — High
**Where:** `swift/Sources/TaskDetailView.swift:97-106` (break at `:102`)
**Problem:** The event loop breaks when `TaskState(live).isTerminal`, and `isTerminal`
(`DesignSystem.swift:220-222`) includes `.failed`, `.cancelled`, `.blocked` and `.needsInput` — exactly
the states from which the app itself restarts a run. `.task(id: task.id)` cannot re-fire, because the
task id has not changed; `resetEventState()` and `loadEvents()` are only reachable from that `.task`
block and from the Retry button, which is only visible when `loadFailed` is true. `!loading` in the break
condition is always true after the first iteration, so it gates nothing.
**Why it matters:** The Resume button lives in this very header (`:197-199`). Press it and the worker
runs again for minutes while the Activity tab shows the old, settled trace with no indication it is
stale. Same for a `needs_input` task answered by the calling agent. Recovery requires selecting another
task and coming back.
**Fix:** Keep the break (not polling a settled task is the right default) and re-arm it:
`.onChange(of: task.state) { _, new in if !TaskState(new).isTerminal { /* restart the loop */ } }`,
restarting via a stored `Task` handle rather than by mutating the `.task(id:)` key — keying `.task` on
`"\(task.id)-\(task.state)"` would also work but wipes and refetches the trace from cursor 0 on every
state change.
**Risk:** RISKY — core behavior (event polling loop).
**Effort:** M

### 3. Parsing, trace composition and diffing all run inside `body`, on every poll — High
**Where:** `swift/Sources/ReviewContent.swift:234-241`; `swift/Sources/TaskDetailView.swift:304`;
`swift/Sources/EventExpansion.swift:59`
**Problem:** `TaskDetail` stores a closure (`setArchived`), so SwiftUI cannot equality-elide it; its
`body` re-runs whenever `ContentView` re-renders, which is every `/api/state` poll that changes any
task's `updatedAt` — roughly every 2s while anything is running. Each of those evaluations:
- `ReviewContentView.body` constructs `ReviewContent(source)` from scratch (`ReviewContent.swift:235`),
  which attempts a full `JSONDecoder` decode of the string and then runs `MarkdownParser.parse` over it.
  The sources are `task.prompt` and `task.output` (`TaskDetailView.swift:131,136`) — per the broker's own
  payload audit, prompts average ~8,000 characters and peak above 34,000.
- `eventContent` calls `ActivityStory.compose(events)` (`TaskDetailView.swift:304`), which re-folds and
  re-classifies the entire event array — thousands of events on a long run.
- Every code fence re-runs `CodeStyle.highlighted` (`ReviewContent.swift:288`), a character-by-character
  scan, and every expanded row re-runs `EventExpansion(event:)` (`EventExpansion.swift:59`), which
  re-parses the raw JSON payload and re-computes an O(n·m) LCS diff (`FileChange.swift:212-240`).
**Why it matters:** This is the app's hot path doing its heaviest work for no reason — the inputs did not
change. It is also why the pure/impure split, which the repo otherwise gets right, does not pay off here.
**Fix:** Memoize at the three call sites, keyed on the input that actually changes.
- `ReviewContentView`: hold `@State private var content: ReviewContent?` and fill it in
  `.task(id: source) { content = ReviewContent(source) }`, rendering nothing (or the raw text) until set.
- `TaskDetail`: hold `@State private var story: ActivityStory.Composition` and recompute it in
  `appendEvents(_:)`, which is the one place `events` changes — `body` then only reads it.
- `EventExpansionView`: same shape, `@State` filled in `.task(id: event.id)`.
None of these change what is rendered.
**Risk:** none (`ReviewContentView`, `EventExpansionView`), behavior-adjacent (`TaskDetail`, because the
composition moves from render time to append time).
**Effort:** M

### 4. A transient fetch failure erases an already-rendered trace — High
**Where:** `swift/Sources/TaskDetailView.swift:284-303`, set at `:351-352,368-371`
**Problem:** `eventContent` tests `loading`, then `loadFailed`, then `events.isEmpty` — in that order —
so once `loadFailed` is true the whole trace is replaced by a "Couldn't load activity." card even though
`events` still holds every event already fetched. `loadEvents` sets `loadFailed = true` on any thrown
error, including a cut long-poll or a broker restart.
**Why it matters:** The read surface for a live run vanishes and comes back on the next successful poll —
a flicker that looks like data loss, on the one screen a user watches for minutes.
**Fix:** Show the failure as a banner above the trace instead of in place of it: keep the error card only
when `events.isEmpty`, otherwise render the trace with a small "Reconnecting…" row. Same edit collapses
the three-boolean state machine (`loading`, `loadFailed`, `events.isEmpty`) into one
`enum TraceState { case loading, failed, empty, loaded }` — currently `loadFailed && !events.isEmpty` is
representable and mishandled, which is the defect.
**Risk:** behavior-adjacent (changes what is shown on failure — deliberately).
**Effort:** S

### 5. `TaskDetailView.swift` is three files and eighteen types — High
**Where:** `swift/Sources/TaskDetailView.swift:1-1091`
**Problem:** One file holds the detail controller, the resume sheet, the needs-input banner, the panel
wrapper, eight activity-trace views, four chrome components, and one free string function.
`TaskDetail` itself (`:31-389`) owns eleven `@State` properties, a paging HTTP client, two confirmation
flows and the header layout.
**Why it matters:** Nothing in the trace-rendering half depends on `TaskDetail`'s state — verified: every
type from `:471` to `:932` reads only its own stored properties plus `EventExpansion`, `FileChange`,
`CodeStyle` and `Surface`. They are in this file by accretion, and their presence is what makes the file
unnavigable. The clearest evidence is that the file grew from 996 to 1091 lines *during this review* —
`ActivityHandoffCard` (`:720-782`) landed in exactly the region this finding says does not belong here,
and every anchor below it moved. That is the maintenance cost, measured.
**Fix:** Two file moves, no logic changes (the moved types are `private`, so they become `internal` or
`fileprivate` in the new file):
- `ActivityTraceViews.swift` ← `:471-932`: `ActivityBlockView`, `ActivityChapterCard`, `ActivityWorkRow`,
  `ActivityReasoningRow`, `ActivitySignalCard`, `ActivityHandoffCard`, `ActivityReceiptCard`,
  `TaskEventPresentationView` (≈460 lines). Sits next to `ActivityStory.swift`, whose output it renders.
- `TaskDetailChrome.swift` ← `:456-469` and `:933-1091`: `TaskPanel`, `TaskStateChip`, `TaskMetaChip`,
  `TaskSectionTabs`, `TaskFactRow` (≈160 lines).
- `middleTruncated(_:maxChars:)` (`:954-960`) is a pure, tested, module-internal string function wedged
  between two view structs. It belongs in `DesignSystem.swift` next to the other shared primitives, not
  in whichever view happened to need it first.
What remains is a ~430-line `TaskDetailView.swift`: the section enum, `TaskDetail`, `ResumeSheet`,
`NeedsInputBanner`. Do this before findings 3, 6 and 11 — they all edit code that moves.
**Risk:** none.
**Effort:** S

### 6. Cancel/resume preconditions and their copy are written twice — Medium
**Where:** `swift/Sources/ContentView.swift:219-225` and `swift/Sources/TaskDetailView.swift:253-260`
**Problem:** The two predicate bodies are identical (`[.queued, .running, .needsInput, .blocked]` and
`[.failed, .cancelled, .blocked]`), and the comment at `ContentView.swift:217-218` documents the
duplication instead of removing it. `performCancel`/`performResume` (`ContentView.swift:227-241`,
`TaskDetailView.swift:270-282`), the confirmation dialog and its message (`ContentView.swift:148-163`,
`TaskDetailView.swift:108-115`) and the failure alert (`ContentView.swift:164-166`,
`TaskDetailView.swift:123-125`) are likewise duplicated verbatim.
**Why it matters:** These predicates mirror the broker's own transition rules — `src/tasks.ts:822` for
resume. When the broker adds a state, two files must change in lockstep or a menu offers an action the
broker rejects. Neither copy is tested.
**Fix:** Put the rules where `TaskState` already lives (`DesignSystem.swift:154-223`) as
`var canCancel: Bool` / `var canResume: Bool`, and test them — they are pure and the repo's test style
covers exactly this kind of mapping. Extract the shared dialog and alert into one
`TaskActionDialogs(taskID:onCancel:)` view modifier used by both call sites, so the destructive copy has
one home.
**Risk:** none.
**Effort:** S

### 7. Dead published state and unread fields cost a decode every 2 seconds — Medium
**Where:** `swift/Sources/ProfileStore.swift:9-12,32-36,153-166`; `swift/Sources/Models.swift:82-86`
**Problem:** `profileFailures` and `grants` are decoded on every poll and never read by any view
(verified by grep across `Sources/` and `Tests/`). `error` is assigned in eight places
(`ProfileStore.swift:39,75,81,100,107,124,130,143,149,160,164`) and read nowhere — every view uses its own
local `showing…Error` flag instead. `revokeGrant(_:)` (`:153-166`) has no caller, and
`TaskScopeSnapshot`/`ScopeGrantSnapshot` exist only to support it. On `TaskSnapshot`, `shippedPrompt` and
`grantId` are decoded and never read; `shippedPrompt` alone averages ~8,000 characters per task and rides
`/api/state` for every unarchived task.
**Why it matters:** Reading `store.error` looks like a supported way to surface failures and is not; a
future edit will use it and silently show nothing. The unread fields make every poll allocate and discard
strings proportional to the whole task table.
**Fix:** Delete `error`, `profileFailures`, `grants`, `revokeGrant`, `ScopeGrantSnapshot` and
`TaskScopeSnapshot`, and drop `shippedPrompt`/`grantId` from `TaskSnapshot` (extra JSON keys are ignored
by `Codable`, so removal is safe and reduces decode work). Keep `BrokerState.profileFailures`/`grants` out
of the struct too — they are decoded only to be thrown away. If any of this is a staged feature, say so
in a comment naming what will read it; today nothing does.
**Risk:** none.
**Effort:** S

### 8. Wire enums arrive as bare `String` and behavior keys off human-readable titles — Medium
**Where:** `swift/Sources/Models.swift:115-152`; switched at `swift/Sources/TaskDetailView.swift:586-594,
606,632,862-919`, `swift/Sources/ActivityStory.swift:77,144,149,264,269`,
`swift/Sources/EventExpansion.swift:18,34,46-47`
**Problem:** `TaskEventSnapshot.kind`, `.phase`, `.source` and `TaskEventPresentationSnapshot.type`,
`.level` are closed unions on the wire (`src/events.ts:4-48`) and plain `String` in Swift. There are
fourteen string comparisons against them across four files; a typo compiles and silently renders nothing
(`TaskEventPresentationView`'s `default: EmptyView()` at `:918-919` swallows it). Worse,
classification keys off *display titles* the server generates from `lifecycleTitle`/`humanize`
(`src/events.ts:718-726,1044-1046`): `"Worker needs input"`, `"Heartbeat"`, `"Rate limit"`,
`"API retry"`, `"Session Captured"`, `"Step Start"` (`ActivityStory.swift:147-156,250-265`;
`TaskDetailView.swift:708-712`). Renaming a user-facing label on the broker silently reclassifies events
in the app.
**Why it matters:** The repo already solved this: `TaskState(_ raw: String)` decodes an unknown state to
`.unknown` (`DesignSystem.swift:157`) rather than trusting the wire. That pattern was not applied to the
event types, which are the ones with fourteen call sites.
**Fix:** Add `EventKind`, `EventPhase`, `PresentationType` as `String`-raw enums with an `unknown` case
and the same `init(_ raw:)` fallback, expose them as computed properties over the stored strings so
decoding a new server value still succeeds, and switch on those. For the title-keyed logic, prefer the
fields that are contracts — `kind`, `phase`, `presentation.type`, `minor` — and where a title genuinely
is the only signal (`isStalledHeartbeat`), keep it but centralize the literals in one place with a
comment pointing at `src/events.ts:718`.
**Risk:** behavior-adjacent (an unmapped value must fall to `unknown`, matching today's `default` arms).
**Effort:** M

### 9. Secret masking is implemented twice with different rules, and the reveal button reveals bullets — Medium
**Where:** `swift/Sources/ContentView.swift:383-412` (`isSecret` at `:388-390`) vs `src/cli.ts:608-616`
**Problem:** The broker already masks env values whose key matches `/(?:KEY|TOKEN|SECRET|PASS)/i`,
replacing them with `"••••••••"` before they leave `/api/state`. The client then applies its *own*
different rule — `["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"]` — to values that are already
masked. The two sets disagree in both directions: `PASSPHRASE` is masked by the broker but not
recognised by the client (so it renders the bullets as if they were the value, with no reveal control),
and `CREDENTIAL` is recognised by the client but *not* masked by the broker (so a real secret arrives in
plaintext and the eye button genuinely reveals it — the only case where the control does anything).
For every key the broker did mask, `revealed = true` shows `••••••••`, and `CopyIconButton(text: value)`
at `:406` copies the bullets to the clipboard.
**Why it matters:** A security affordance that lies. The user cannot tell "masked by the broker" from
"hidden by the app", and the copy button silently yields garbage.
**Fix:** Delete the client-side pattern. Detect the broker's sentinel instead —
`let isMasked = value == "••••••••"` — and for a masked value render the bullets with no eye and no copy
button, plus a `.help("Value hidden by the broker")`. Reveal and copy stay only for values that arrived
in the clear. If `CREDENTIAL` should be secret, that belongs in the broker's regex, not in the view.
**Risk:** behavior-adjacent (removes a control that currently does nothing for masked keys).
**Effort:** S

### 10. Unreachable decode fallback, and `try?` hides why the trace failed to load — Medium
**Where:** `swift/Sources/TaskDetailView.swift:354-365`
**Problem:** `try? JSONDecoder().decode(TaskEventPage.self, ...)` discards the decode error; on `nil` the
code falls through to decoding a bare `[TaskEventSnapshot]`. That fallback cannot be reached: the client
always sends both `after` and `waitMs` (`:345-348`), and the broker returns the bare array only when
*neither* is present (`src/cli.ts:160-161`). So a real `TaskEventPage` schema mismatch is swallowed by
`try?`, then re-surfaces as the array decode throwing, and the user sees the generic "Couldn't load
activity." while the loop retries every second forever.
**Why it matters:** The one place a wire mismatch would be diagnosable throws the diagnosis away, and
seven lines of compatibility code protect against a request this client never makes.
**Fix:** `let page = try JSONDecoder().decode(TaskEventPage.self, from: data)` and delete `:359-365`.
If tolerance for an older broker is wanted, keep the fallback but capture the primary error and include
it in the failure card rather than dropping it.
**Risk:** behavior-adjacent (an older broker's array response would now fail loudly).
**Effort:** S

### 11. Presentation logic is trapped inside private view structs, so none of it is testable — Medium
**Where:** `swift/Sources/TaskDetailView.swift:630-640` (`chips`), `:840-853` (`stats`), `:582-595`
(`blockPresentation`), `:693-714` (`severity`/`tint`/`symbol`), `:657-661` (`ActivityReasoningRow.label`)
**Problem:** These are pure functions of a `TaskEventSnapshot` — no view state, no environment — living as
private computed properties on private views. `stats` alone has seven conditional appends, an ordering
contract and a `prefix(6)` cap. `chips` encodes a real rule ("a command that ended the ordinary way says
so by not saying anything") by suppressing `"completed"`, `"success"` and `exit 0`. None of it can be
reached from a test.
**Why it matters:** The repo's own pattern is the opposite, and it works: `TaskGrouping.swift` and
`EventExpansion.swift` exist precisely so grouping and expansion rules could be tested without a view,
and they have 24 and 10 tests. The strongest precedent is in this very file: `middleTruncated(_:maxChars:)`
(`TaskDetailView.swift:954-960`) was pulled out of `TaskMetaChip` as a free function and immediately got
`swift/Tests/MiddleTruncationTests.swift`. These five properties are the same kind of rule, left inside
the view.
**Fix:** Move them next to the logic they belong to — `chips`/`stats` as `static func` on a new
`ActivityRowModel` (or as extensions on `TaskEventSnapshot` in `ActivityStory.swift`), `severity`/`symbol`
as an `ActivitySignal` enum, `label` as a method on `ActivityStory.ReasoningPulse`. Views then call one
function each. Test the suppression rules and the six-stat cap directly.
**Risk:** none.
**Effort:** M

### 12. Two implementations of the file-presentation row in one file — Medium
**Where:** `swift/Sources/TaskDetailView.swift:605-625` and `:863-876`
**Problem:** `ActivityWorkRow.inlineContent` and `TaskEventPresentationView`'s `case "file"` both render
a middle-truncated monospaced path followed by `[change, outcome]` chips. The chip construction is
byte-identical in both — `.scaledFont(.caption, weight: .medium, design: .monospaced)`, `.lineLimit(1)`,
`.padding(.horizontal, 6)`, `.padding(.vertical, 2)`, `.background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))`.
**Why it matters:** Two places to change one visual decision, forty lines apart, in the file that is
already too long. The chip is also the app's most-repeated construction and has no component.
**Fix:** Add `struct MetaChip: View { let text: String }` to `DesignSystem.swift` next to `SectionLabel`,
and `struct FilePresentationRow: View { let path: String?; let chips: [String] }` to the new
`ActivityTraceViews.swift`. Both call sites become one line.
**Risk:** none.
**Effort:** S

### 13. `ContentView` mixes three sidebar sections, the detail router, and all list preferences — Medium
**Where:** `swift/Sources/ContentView.swift:26-306`
**Problem:** `body` runs 142 lines with the task section nested six builders deep (`List` → `Section` →
`ForEach(taskGroups)` → `ForEach(visibleTasks)` → `TaskRow` → `.contextMenu` → `Button`, `:41-87`).
`ContentView` owns four `@AppStorage` keys, eight derived properties
(`visibleTasks`, `projects`, `activeProjectName`, `grouping`, `collapsedGroups`, `taskGroups`,
`listedTaskIDs`, `isFiltering`) and the filter menu — all of which belong to one of its three sections —
plus the profile-detail form, the env row and the enabled toggle.
**Why it matters:** Every task-list change touches the file that also owns the window's detail router and
the worker form. The `@AppStorage` keys are the giveaway: they are the task list's private preferences
sitting in the window's root view.
**Fix:** Two extractions.
- `TaskSidebarSection.swift` ← `:41-87`, `:170-204`, `:245-282`, `TaskRow` (`:491-527`),
  `TaskGroupHeader` (`:416-442`). Owns the four `@AppStorage` keys and the eight derived properties; takes
  `tasks: [TaskSnapshot]`, `workerLabel: (String) -> String`, `selection: Binding<SidebarSelection?>` and
  the cancel/resume/archive callbacks.
- `ProfileDetailView.swift` ← `ProfileDetail` (`:308-381`), `EnvironmentRow` (`:383-412`),
  `EnabledToggle` (`:529-553`).
`ContentView` drops to ~250 lines and reads as what it is: three sections, a detail router, three sheets.
**Risk:** none.
**Effort:** M

### 14. `blockPresentation` guards on a condition it then re-tests — Low
**Where:** `swift/Sources/TaskDetailView.swift:582-595`
**Problem:** `guard !isQuote, let presentation = event.presentation else { return isQuote ? nil : fallbackDetail }`
re-tests `isQuote` inside the `else` of a guard that already failed for one of two reasons, and
`fallbackDetail` (`:597-600`) then re-tests `event.presentation == nil`, which is the only way it can be
reached. Three tests for two facts.
**Fix:**
```swift
private var blockPresentation: TaskEventPresentationSnapshot? {
    guard !isQuote else { return nil }
    guard let presentation = event.presentation else {
        return event.detail.map { TaskEventPresentationSnapshot(type: "message", text: $0) }
    }
    switch presentation.type {
    case "file", "command": return nil
    case "usage", "signal":
        return event.detail.map { TaskEventPresentationSnapshot(type: "message", text: $0) }
    default: return presentation
    }
}
```
and delete `fallbackDetail`. Same output for every input.
**Risk:** none.
**Effort:** S

### 15. `Typeface` is a two-case switch with one reachable case — Low
**Where:** `swift/Sources/DesignSystem.swift:40-50`
**Problem:** `Typeface.current` is `static let current: Typeface = .data`, so `Typeface.design(_:)` is a
compile-time identity function and `.mono` is unreachable. Its only caller is `Font.scaled` (`:104`).
**Why it matters:** It reads as a runtime setting and is a constant — the comment describes a feature the
type does not provide.
**Fix:** Delete the enum and pass `design` straight through in `Font.scaled`. The design intent survives
as the comment. Restore it as a real setting only when something can change it.
**Risk:** none.
**Effort:** S

### 16. Archive/restore chooses its action from the sidebar filter, not the task — Low
**Where:** `swift/Sources/ContentView.swift:73-76`
**Problem:** The menu item's title and effect come from `showArchivedTasks`, while
`TaskDetail`'s equivalent button reads `task.archivedAt == nil` (`TaskDetailView.swift:208-213`). The two
agree only because `visibleTasks` filters on the same flag — until a poll lands between render and click,
or another client archives the task.
**Fix:** Use `task.archivedAt == nil` in both places. One fact, one source.
**Risk:** none.
**Effort:** S

### 17. `installEverywhere` does synchronous file I/O on the main actor — Low
**Where:** `swift/Sources/ContentView.swift:115-118`
**Problem:** The toolbar button synchronously creates directories, copies backups and writes four or more
config files inside the button action, blocking the UI.
**Fix:** `Task { let results = await Task.detached { MCPConfigInjector.installEverywhere(profiles:) }.value; installResults = results; showingInstall = true }`. `MCPConfigInjector` is a stateless enum, so
nothing else needs to move.
**Risk:** behavior-adjacent (the sheet now appears a frame later).
**Effort:** S

### 18. The hit-target test documents a 24pt floor and asserts 20 — Low
**Where:** `swift/Tests/AppZoomTests.swift:106-115`
**Problem:** The doc comment says "A 24pt icon target at 100% is the accessibility floor; it must not
shrink below it when the user zooms out", and the assertion is `XCTAssertGreaterThanOrEqual(height, 20)`
at scale 0.85 — where `IconButton`'s `24 * uiScale` (`DesignSystem.swift:311`) is 20.4. The floor is not
enforced; the test encodes the violation. `JSONTreeRow`'s disclosure button uses `20 * uiScale`
(`ReviewContent.swift:420,426`), i.e. 17pt at minimum zoom, and is not covered at all.
**Fix:** Decide which is true. Either clamp — `.frame(width: max(24, 24 * uiScale), ...)` in `IconButton`
and assert `>= 24` — or correct the comment to say the target scales with zoom and 20pt is the accepted
minimum. Then give `JSONTreeRow`'s button `IconButton`'s metric so there is one target size in the app.
**Risk:** none (test and comment), behavior-adjacent if the metric changes.
**Effort:** S

## Wire-contract check

`TaskEventSnapshot` and `TaskEventPresentationSnapshot` (`Models.swift:115-152`) match `TaskEventView`
and `TaskEventPresentation` (`src/events.ts:4-48`) field for field, including optionality. `Profile`,
`ProfileFailureSnapshot`, `ScopeGrantSnapshot`, `TaskScopeSnapshot`, `MemorySnapshot` and
`MemoryProjectSnapshot` all match their TS counterparts. Drift is confined to `TaskSnapshot`:

| Field | Broker | `Models.swift` | Consequence |
| --- | --- | --- | --- |
| `tldr` | `Task.tldr?`, `TaskSummary.tldr?`, `waitTaskView` — documented "shown in the app's task list" (`types.ts:145-146`), and it rides every `wait` poll on purpose (`public-task.ts:143-145`) | **absent** | The caller's own one-line handle never reaches the UI. `displayLabel` (`Models.swift:106-112`) falls back from `title` straight to the prompt's first line. This is the one drift where the broker's contract explicitly names the app as the consumer. Fix: add `var tldr: String? = nil` and prefer `title ?? tldr ?? firstLine` in `displayLabel` — `TaskGroupingTests:195-206` already pins the `title`-wins and prompt-fallback ends, so a `tldr` case slots between them. |
| `completion` (`code`, `blocked`, `reason`, `suggestedScope`) | always set with the terminal state (`tasks.ts:608-614`) | **absent** | `reason` survives via `task.error`, so nothing is lost for display. `suggestedScope` is: the broker computes a scope that would have survived the run's denials specifically so "resume is an approval, not a log-reading exercise" (`tasks.ts:671-674`), and the app's Resume button cannot see it. |
| `scope`, `allowQuestions`, `timeoutMs`, `attempts` | on the wire for every task | **absent** | Never surfaced. `grants` is decoded instead and also unread (finding 7). |
| `effort` | `Task.effort?` (`types.ts:125`) | present and rendered (`Models.swift:66-67`, header chip at `TaskDetailView.swift:177-183`) | No drift. Added after the first pass of this review; the pattern it follows — decode the optional, render a `TaskMetaChip`, absent means "caller set none" — is the one `tldr` should copy. |
| `shippedPrompt`, `grantId` | on the wire | present, never read | Decoded and discarded every 2s (finding 7). |
| `Profile.model` | required `string`; `normalizeProfile` and the PUT handler both substitute the provider default (`profile-input.ts:10`, `cli.ts:203-207`) | `String?` | Inbound, `nil` is unreachable — `resolvedModel` (`Models.swift:59`) exists to handle a case the broker cannot send. Outbound it is load-bearing: `ProfileFormView:41-47` uses `nil` to mean "use the provider default", and `Codable` omits the key so the broker fills it. Leave as is; the asymmetry is deliberate and worth the one-line comment it does not have. |
| `TaskState.answered` | declared in `types.ts:6` and validated in `cli.ts:48`, but no code path ever assigns it — `answerTask` sets `state = 'queued'` and records an `answered` *event* (`store.ts:441-465`) | `case answered` with label, tint, dot and `isTerminal: true` (`DesignSystem.swift:155-222`) | Dead on both sides. The Swift mirror is faithful; the field is vestigial in the contract. Harmless except that `isTerminal` includes it (finding 2 territory). |
| `BrokerState.memoryProjects` | always emitted (`cli.ts:105`) | `[MemoryProjectSnapshot]?` | Deliberate back-compat, documented at `Models.swift:167-169`. Correct. |

## Nits

- `swift/Sources/TaskDetailView.swift:97-98` — `.task(id: task.id)` and `resetEventState()` are both
  unreachable-on-change: `ContentView.swift:134` already applies `.id(task.id)`, so the view is recreated
  and `@State` starts at those exact defaults. Two mechanisms, one of which cannot fire.
- `swift/Sources/CommandOutput.swift:24-26` — "the end of a run is what states the outcome, so the head
  goes first" reads as *the head is kept*; the code drops the head (`:68` takes `.suffix`). Say "the head
  is dropped".
- `swift/Tests/ReviewContentTests.swift:46-74` — `testOnlyKnownProtocolEventsAreTechnicalNoise` tests
  `ActivityStory` and `testTaskSnapshotDecodesWithAndWithoutSessionId` tests `Models`; neither belongs in
  this file, and the `event(...)` fixture at `:80-91` duplicates the one in `ActivityStoryTests.swift`.
- `swift/Sources/ContentView.swift:529` — `EnabledToggle` is the only non-`private` row type in the file
  and is used once, in the same file.
- `swift/Sources/TaskDetailView.swift:533,797,1056-1059` — `foregroundStyle(cond ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))`
  three times; one `func failureTint(_ failed: Bool) -> AnyShapeStyle` helper covers all three.
- `swift/Sources/DesignSystem.swift:4` — the doc comment promises "one hairline, one hit-target floor";
  neither is a token. `Color(nsColor: .separatorColor)` is written inline at `TaskDetailView.swift:568,753,759`
  and the hit target at `:311`, `:937`, `ReviewContent.swift:420`.
- `swift/Sources/ContentView.swift:194-204` — `taskGroups` is recomputed by `listedTaskIDs` and again per
  `body`; `TaskOrganizer.organize` is cheap, but a single `let groups = taskGroups` at the top of `body`
  would make the dependency obvious.
- `swift/Sources/ProviderMark.swift:4-8` — no mark for `.codex` or `.pi`; both fall back to
  `provider.symbol`, which is correct but undocumented next to the three that do ship.

## What is already good

- `ActivityStory.swift` — the hardest logic in the app (action folding, thinking-pulse collapsing,
  receipt selection, technical classification) is pure, reads top to bottom, and every rule has a comment
  saying what went wrong without it. 19 tests, and they test intent, not implementation. Do not touch it.
- `TaskGrouping.swift` — parent-chain walking with an explicit depth cap and cycle set, stale-filter and
  stale-collapsed-id handling, order preservation as a stated contract. 24 tests. Exemplary.
- `FileChange.swift` and `CommandOutput.swift` — shape-based payload recovery across four providers,
  with the ambiguity cases (`content` on a read, `output` without a command) called out and handled.
  The `mayContainEdit`/`mayContainOutput` substring pre-checks are the right instinct: cheap on the row,
  parse only on expansion.
- `DesignSystem.swift` `TaskState` — one source of truth for label, tint, dot shape, symbol and the two
  "does this state deserve a word" rules, with a `.unknown` fallback so a new broker state cannot crash
  the sidebar. This is the pattern finding 8 asks to copy.
- The comment culture generally. Comments explain the decision and the failure that motivated it
  (`TaskDetailView.swift:89-94` on the scroll anchor, `DesignSystem.swift:282-284` on ending a repeating
  animation, `Makefile:install` on retiring the stale broker). Preserve this when moving code.
- `Package.swift` and the `Makefile` are minimal and do exactly one thing each.

## Suggested order of work

1. **Finding 1** — the config corruption. Independent of everything else, and it touches a user's files.
2. **Finding 5** — the two file moves. Pure mechanical split; do it before anything edits those views.
3. **Findings 2 and 4** — the two trace defects (freeze after Resume, trace erased on a blip). Both are in
   `TaskDetail`; finding 2 is `RISKY — core behavior`, so land 4 first and get 2 reviewed separately.
4. **Finding 3** — memoize the three parse sites. Do `ReviewContentView` and `EventExpansionView` first
   (no risk), then `TaskDetail`'s composition.
5. **Findings 6, 7, 9, 10** — the deletions and de-duplications. Each is small, independent, and shrinks
   the surface the remaining work has to cover.
6. **Findings 11 and 12** — lift the pure row logic out and test it; collapse the duplicate file row.
7. **Findings 8 and 13** — the two larger refactors: typed event enums, `ContentView` split.
8. **Findings 14-18 and the nits** — cleanup pass.
9. **`tldr`** (wire-contract table) — one field, one `displayLabel` line, one test. Product call on
   whether `tldr` outranks the prompt fallback; the broker's comment says it should.
