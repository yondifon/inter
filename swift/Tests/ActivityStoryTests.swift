import XCTest
@testable import Inter

final class ActivityStoryTests: XCTestCase {
    private func event(
        _ id: Int,
        kind: String,
        title: String,
        detail: String? = nil,
        source: String = "claude",
        phase: String = "info",
        presentation: TaskEventPresentationSnapshot? = nil,
        createdAt: String = "2026-07-30T15:00:00.000Z",
        minor: Bool? = nil,
        actionId: String? = nil
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: source, kind: kind, phase: phase,
            title: title, detail: detail, presentation: presentation,
            rawText: nil, createdAt: createdAt, minor: minor, actionId: actionId
        )
    }

    /// The work rows of a chapter. Thinking pulses share the list but carry no
    /// event of their own.
    private func work(_ block: ActivityBlock?) -> [TaskEventSnapshot] {
        guard case .chapter(_, let rows)? = block else { return [] }
        return rows.compactMap { row in
            if case .work(let event) = row { event } else { nil }
        }
    }

    /// The echo and the hooks of one call interleave with another call's, so
    /// only the shared id can pair them.
    func testInterleavedEventsOfTwoActionsFoldToOneRowEach() {
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", detail: "a.rs", actionId: "toolu_a"),
            event(2, kind: "file", title: "Read file", detail: "a.rs",
                  phase: "started", actionId: "toolu_a"),
            event(3, kind: "file", title: "Read file", detail: "b.rs", actionId: "toolu_b"),
            event(4, kind: "file", title: "Read file", detail: "b.rs",
                  phase: "started", actionId: "toolu_b"),
            event(5, kind: "file", title: "Read file", detail: "a.rs",
                  phase: "completed", createdAt: "2026-07-30T15:00:09.000Z", actionId: "toolu_a"),
            event(6, kind: "file", title: "Read file", detail: "b.rs · denied",
                  phase: "failed", actionId: "toolu_b"),
        ])
        let rows = work(story.blocks.first)
        XCTAssertEqual(rows.map(\.id), [1, 3])
        XCTAssertEqual(rows.map(\.phase), ["completed", "failed"])
        XCTAssertEqual(rows[1].detail, "b.rs · denied")
        // The row is stamped when the action began, not when its last hook landed.
        XCTAssertEqual(rows[0].createdAt, "2026-07-30T15:00:00.000Z")
    }

    /// The result is folded away, but it is the only event that says what the
    /// call produced, so its outcome has to survive onto the call's row.
    func testResultLiftsItsOutcomeOntoTheCallAndKeepsNoRowOfItsOwn() {
        let call = TaskEventPresentationSnapshot(type: "file", path: "src/http/operator_locality.rs")
        let result = TaskEventPresentationSnapshot(type: "tool", outcome: "298 lines read")
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", phase: "started",
                  presentation: call, actionId: "toolu_1"),
            event(2, kind: "raw", title: "Tool result", presentation: result,
                  minor: true, actionId: "toolu_1"),
            event(3, kind: "file", title: "Read file", phase: "completed",
                  presentation: call, actionId: "toolu_1"),
        ])
        let rows = work(story.blocks.first)
        XCTAssertEqual(rows.map(\.id), [1])
        XCTAssertEqual(rows[0].phase, "completed")
        XCTAssertEqual(rows[0].presentation?.outcome, "298 lines read")
        XCTAssertTrue(story.technical.isEmpty)
    }

    /// The hook and the result both carry a failed call's error; the row says
    /// it once.
    func testOutcomeIsDroppedWhenTheRowAlreadyStatesIt() {
        let error = "File does not exist. Note: your current working directory is /Users/malico/desgn/kii."
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", detail: "…/kii/AGENTS.md",
                  presentation: TaskEventPresentationSnapshot(type: "file", path: "…/kii/AGENTS.md"),
                  actionId: "toolu_1"),
            event(2, kind: "file", title: "Read file", detail: "…/kii/AGENTS.md · \(error)",
                  phase: "failed",
                  presentation: TaskEventPresentationSnapshot(type: "file", path: "…/kii/AGENTS.md"),
                  actionId: "toolu_1"),
            event(3, kind: "raw", title: "Tool result", phase: "failed",
                  presentation: TaskEventPresentationSnapshot(type: "tool", outcome: "Error: \(error)"),
                  minor: true, actionId: "toolu_1"),
        ])
        let rows = work(story.blocks.first)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].phase, "failed")
        XCTAssertNil(rows[0].presentation?.outcome)
        XCTAssertEqual(rows[0].detail, "…/kii/AGENTS.md · \(error)")
    }

    /// pi and opencode close a call with `tool_execution_end`, which carries
    /// no arguments — the presentation on that event is a bare
    /// `{ type: "tool", outcome: … }`. The opening event still named the
    /// path; the merged row has to keep it.
    func testBareToolCloseKeepsTheOpeningFilePresentation() {
        let opened = TaskEventPresentationSnapshot(type: "file", path: "/Users/malico/desgn/inter/src/watch.ts")
        let closed = TaskEventPresentationSnapshot(type: "tool", outcome: "120 lines read")
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", phase: "started",
                  presentation: opened, actionId: "call_01_mAGVOtEM8NoYL0GYE9A29838"),
            event(2, kind: "tool", title: "Read file", phase: "completed",
                  presentation: closed, actionId: "call_01_mAGVOtEM8NoYL0GYE9A29838"),
        ])
        let rows = work(story.blocks.first)
        XCTAssertEqual(rows.map(\.id), [1])
        XCTAssertEqual(rows[0].kind, "file")
        XCTAssertEqual(rows[0].presentation?.type, "file")
        XCTAssertEqual(rows[0].presentation?.path, "/Users/malico/desgn/inter/src/watch.ts")
        XCTAssertEqual(rows[0].presentation?.outcome, "120 lines read")
    }

    /// A closing event that genuinely knows more than the opening one — its
    /// own path or command, not just an outcome — still has to win. The fix
    /// for the bare-tool case must not invert this.
    func testRicherClosingEventStillWins() {
        let opened = TaskEventPresentationSnapshot(type: "file", path: "a.rs")
        let closedWithPath = TaskEventPresentationSnapshot(type: "file", path: "a.rs", outcome: "12 lines read")
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", phase: "started",
                  presentation: opened, actionId: "toolu_1"),
            event(2, kind: "file", title: "Read file", phase: "completed",
                  presentation: closedWithPath, actionId: "toolu_1"),
        ])
        let rows = work(story.blocks.first)
        XCTAssertEqual(rows.map(\.id), [1])
        XCTAssertEqual(rows[0].presentation?.path, "a.rs")
        XCTAssertEqual(rows[0].presentation?.outcome, "12 lines read")
        XCTAssertEqual(rows[0].phase, "completed")
    }

    func testResultWithNoCallToAttachToStaysTechnical() {
        let story = ActivityStory.compose([
            event(1, kind: "raw", title: "Tool result",
                  presentation: TaskEventPresentationSnapshot(type: "tool", outcome: "2 lines out"),
                  minor: true, actionId: "toolu_orphan"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1])
        XCTAssertTrue(story.blocks.isEmpty)
    }

    func testOnlyTheNewestStallEarnsASignal() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Heartbeat", detail: "No agent event for 35s"),
            event(2, kind: "command", title: "Bash", detail: "ls"),
            event(3, kind: "lifecycle", title: "Heartbeat", detail: "No agent event for 45s"),
            event(4, kind: "lifecycle", title: "Heartbeat", detail: "No agent event for 55s"),
        ])
        let signals = story.blocks.compactMap { block -> TaskEventSnapshot? in
            guard case .signal(let event) = block else { return nil }
            return event
        }
        XCTAssertEqual(signals.map(\.id), [4])
        XCTAssertEqual(story.technical.map(\.id), [1, 3])
    }

    func testCollapsesThinkingRunIntoOnePulse() {
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file"),
            event(2, kind: "reasoning", title: "Thinking", detail: "~1.0k tokens so far",
                  createdAt: "2026-07-30T15:00:10.000Z"),
            event(3, kind: "reasoning", title: "Thinking", detail: "~5.3k tokens so far",
                  createdAt: "2026-07-30T15:00:56.000Z"),
            event(4, kind: "command", title: "Bash"),
        ])
        // One card holding the read, the thinking, and the command that followed.
        XCTAssertEqual(story.blocks.count, 1)
        guard case .chapter(_, let rows) = story.blocks[0], case .reasoning(let pulse) = rows[1] else {
            return XCTFail("expected a pulse inside the chapter, got \(story.blocks)")
        }
        XCTAssertEqual(rows.map(\.id), [1, 2, 4])
        XCTAssertEqual(pulse.detail, "~5.3k tokens")
        XCTAssertEqual(pulse.updates, 2)
        XCTAssertEqual(pulse.seconds, 46)
    }

    /// Hidden events sit between the ticks of one think all the time — a
    /// heartbeat, a tool result, a hook. Breaking the pulse on them turned one
    /// line into a stack of near-identical ones.
    func testHiddenEventsDoNotSplitAThinkingRun() {
        let story = ActivityStory.compose([
            event(1, kind: "reasoning", title: "Thinking", detail: "~1.0k tokens so far"),
            event(2, kind: "lifecycle", title: "Heartbeat", detail: "Running for 30s"),
            event(3, kind: "reasoning", title: "Thinking", detail: "~2.5k tokens so far",
                  createdAt: "2026-07-30T15:00:12.000Z"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [2])
        guard case .reasoning(let pulse) = story.blocks.first, story.blocks.count == 1 else {
            return XCTFail("expected one pulse line, got \(story.blocks)")
        }
        XCTAssertEqual(pulse.detail, "~2.5k tokens")
        XCTAssertEqual(pulse.updates, 2)
    }

    /// pi's reasoning events carry the prose of the thought itself, flushed
    /// about once a second. A run of those must not land its last paragraph
    /// on the pulse line — the line falls back to "Thinking" and leaves the
    /// summary to `updates`/`seconds`.
    func testProseThinkingDoesNotLeakOntoThePulseLine() {
        let story = ActivityStory.compose([
            event(1, kind: "reasoning", title: "Thinking",
                  detail: "Let me look at how the events are shaped before touching the merge.",
                  createdAt: "2026-07-30T15:00:00.000Z"),
            event(2, kind: "reasoning", title: "Thinking",
                  detail: "The closing event only carries an outcome, so the opening one has to win.",
                  createdAt: "2026-07-30T15:00:01.000Z"),
            event(3, kind: "reasoning", title: "Thinking",
                  detail: "I'll graft the outcome onto the first event's presentation instead.",
                  createdAt: "2026-07-30T15:00:02.000Z"),
        ])
        guard case .reasoning(let pulse) = story.blocks.first, story.blocks.count == 1 else {
            return XCTFail("expected one pulse line, got \(story.blocks)")
        }
        XCTAssertEqual(pulse.detail, "Thinking")
        XCTAssertEqual(pulse.updates, 3)
        XCTAssertEqual(pulse.seconds, 2)
    }

    /// claude's thinking events are a token ticker — the counter shape must
    /// keep clearing the prose filter exactly as it did before the filter
    /// existed.
    func testCounterShapedThinkingSurvivesThePulseLine() {
        let story = ActivityStory.compose([
            event(1, kind: "reasoning", title: "Thinking", detail: "~1.2k tokens so far",
                  createdAt: "2026-07-30T15:00:00.000Z"),
            event(2, kind: "reasoning", title: "Thinking", detail: "~5.2k tokens so far",
                  createdAt: "2026-07-30T15:00:08.000Z"),
        ])
        guard case .reasoning(let pulse) = story.blocks.first, story.blocks.count == 1 else {
            return XCTFail("expected one pulse line, got \(story.blocks)")
        }
        XCTAssertEqual(pulse.detail, "~5.2k tokens")
        XCTAssertEqual(pulse.updates, 2)
        XCTAssertEqual(pulse.seconds, 8)
    }

    func testCollapsesHookAndEchoRowsOfOneAction() {
        let done = TaskEventPresentationSnapshot(type: "command", command: "bun test", exitCode: 0)
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "bun test", phase: "started"),
            event(2, kind: "command", title: "Bash", detail: "bun test", phase: "completed"),
            event(3, kind: "command", title: "Bash", detail: "bun test", phase: "completed", presentation: done),
            event(4, kind: "file", title: "Read file", detail: "src/a.ts"),
        ])
        let rows = work(story.blocks[0])
        XCTAssertEqual(rows.map(\.id), [3, 4])
        XCTAssertEqual(rows[0].presentation?.exitCode, 0)
    }

    func testServerMinorFlagFoldsEventsAway() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Hook finished", detail: "SessionStart", presentation: nil),
            event(2, kind: "command", title: "Bash", detail: "ls"),
        ].enumerated().map { index, base in
            var copy = base
            copy.minor = index == 0
            return copy
        })
        XCTAssertEqual(story.technical.map(\.id), [1])
        XCTAssertEqual(story.blocks.count, 1)
    }

    func testOnlyFinalUsageEventBecomesTheReceipt() {
        let turn = TaskEventPresentationSnapshot(type: "usage", tokensOut: 104)
        let final = TaskEventPresentationSnapshot(type: "usage", costUsd: 0.17, turns: 2)
        let story = ActivityStory.compose([
            event(1, kind: "usage", title: "Turn completed", presentation: turn),
            event(2, kind: "message", title: "Agent message", detail: "done"),
            event(3, kind: "usage", title: "Run summary", presentation: final),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1])
        guard case .receipt(let receipt, _) = story.blocks.last else {
            return XCTFail("expected trailing receipt, got \(String(describing: story.blocks.last))")
        }
        XCTAssertEqual(receipt.id, 3)
    }

    /// The provider's counter restarts each turn, so only the deltas add up to
    /// what the run actually spent on reasoning.
    func testReceiptTotalsThinkingTokensAcrossTurnResets() {
        func tick(_ id: Int, _ total: Int, delta: Int) -> TaskEventSnapshot {
            event(id, kind: "reasoning", title: "Thinking", detail: "~\(total) tokens so far",
                  presentation: TaskEventPresentationSnapshot(type: "usage", tokensThinking: delta))
        }
        let story = ActivityStory.compose([
            tick(1, 450, delta: 450),
            tick(2, 472, delta: 22),
            event(3, kind: "command", title: "Bash", detail: "ls"),
            tick(4, 50, delta: 50),
            tick(5, 74, delta: 24),
            event(6, kind: "usage", title: "Run summary",
                  presentation: TaskEventPresentationSnapshot(type: "usage", tokensOut: 900)),
        ])
        guard case .receipt(_, let thinking) = story.blocks.last else {
            return XCTFail("expected trailing receipt, got \(String(describing: story.blocks.last))")
        }
        XCTAssertEqual(thinking, 546)
    }

    /// Antigravity states the run's reasoning total on the receipt itself, so
    /// there are no per-turn deltas to add up.
    func testReceiptKeepsItsOwnThinkingTotal() {
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file"),
            event(2, kind: "usage", title: "Run summary",
                  presentation: TaskEventPresentationSnapshot(
                      type: "usage", tokensOut: 33_603, tokensThinking: 24_633)),
        ])
        guard case .receipt(_, let thinking) = story.blocks.last else {
            return XCTFail("expected trailing receipt, got \(String(describing: story.blocks.last))")
        }
        XCTAssertEqual(thinking, 24_633)
    }

    func testSignalsBreakChaptersAndKeepOrder() {
        let signal = TaskEventPresentationSnapshot(type: "signal", text: "Attempt 1 of 10", level: "warning")
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file"),
            event(2, kind: "lifecycle", title: "API retry", presentation: signal),
            event(3, kind: "file", title: "Edit file"),
        ])
        XCTAssertEqual(story.blocks.count, 3)
        guard case .chapter(_, let first) = story.blocks[0],
              case .signal(let mid) = story.blocks[1],
              case .chapter(_, let last) = story.blocks[2] else {
            return XCTFail("unexpected block shapes: \(story.blocks)")
        }
        XCTAssertEqual(first.map(\.id), [1])
        XCTAssertEqual(mid.id, 2)
        XCTAssertEqual(last.map(\.id), [3])
    }

    func testStalledHeartbeatIsASignalSteadyOnesAreTechnical() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Heartbeat", detail: "Running for 50s"),
            event(2, kind: "lifecycle", title: "Heartbeat", detail: "No agent event for 109s"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1])
        guard case .signal(let stalled) = story.blocks.first else {
            return XCTFail("expected stall signal, got \(String(describing: story.blocks.first))")
        }
        XCTAssertEqual(stalled.id, 2)
    }

    func testLifecycleStatesTheHeaderShowsStayTechnical() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Task queued"),
            event(2, kind: "lifecycle", title: "Worker started"),
            event(3, kind: "lifecycle", title: "Session started", detail: "claude-sonnet-5 · 30 tools"),
            event(4, kind: "raw", title: "Tool result"),
            event(5, kind: "lifecycle", title: "Task completed"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1, 2, 4, 5])
        XCTAssertEqual(work(story.blocks.first).map(\.id), [3])
    }

    /// Spawn, session capture and archiving are bookkeeping: the header names the
    /// worker, and archiving is something the reader did.
    func testRunBookkeepingStaysTechnical() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Worker spawned", detail: "claude"),
            event(2, kind: "lifecycle", title: "Session Captured", detail: "Root provider session mapped"),
            event(3, kind: "command", title: "Bash", detail: "swift test"),
            event(4, kind: "lifecycle", title: "Archived"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1, 2, 4])
        XCTAssertEqual(work(story.blocks.first).map(\.id), [3])
    }

    /// A progress ping from a run recorded before the broker marked them arrives
    /// as a tool row with nothing on it.
    func testToolRowCarryingNothingStaysTechnical() {
        let story = ActivityStory.compose([
            event(1, kind: "tool", title: "Tool call", actionId: "toolu_a-heartbeat-0"),
            event(2, kind: "tool", title: "Grep", detail: "Pattern: needle"),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1])
        XCTAssertEqual(work(story.blocks.first).map(\.id), [2])
    }

    func testBrokerFailureIsASignal() {
        let story = ActivityStory.compose([
            event(1, kind: "error", title: "Task failed", detail: "exit 1", source: "broker", phase: "failed"),
        ])
        guard case .signal = story.blocks.first else {
            return XCTFail("expected failure signal, got \(String(describing: story.blocks.first))")
        }
    }

    func testAgentErrorStaysInItsChapter() {
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash"),
            event(2, kind: "error", title: "bash failed", detail: "exit 127", phase: "failed"),
        ])
        XCTAssertEqual(story.blocks.count, 1)
        XCTAssertEqual(work(story.blocks[0]).map(\.id), [1, 2])
    }

    // MARK: - Handoff boundaries

    private func handoffEvent(
        _ id: Int,
        detail: String? = "opencode → codex",
        source: String = "broker",
        createdAt: String = "2026-07-30T15:00:00.000Z"
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: source, kind: "lifecycle", phase: "info",
            title: "Handed off to another profile", detail: detail, presentation: nil,
            rawText: nil, createdAt: createdAt, minor: nil, actionId: nil
        )
    }

    /// A trace with no handoff must produce the same blocks as before — no
    /// handoff row, no behavioural change.
    func testNoHandoffLeavesTraceUnchanged() {
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "ls"),
            event(2, kind: "usage", title: "Run summary",
                  presentation: TaskEventPresentationSnapshot(type: "usage", costUsd: 0.01, turns: 1)),
        ])
        let kinds = story.blocks.map { block -> String in
            switch block {
            case .chapter: "chapter"
            case .reasoning: "reasoning"
            case .signal: "signal"
            case .receipt: "receipt"
            case .handoff: "handoff"
            }
        }
        XCTAssertEqual(kinds, ["chapter", "receipt"])
    }

    /// One handoff splits the trace: the prior run collapses into a single row
    /// and the current run stays visible.
    func testOneHandoffCollapsesPriorRun() {
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "ls"),
            event(2, kind: "file", title: "Read file", detail: "a.rs"),
            handoffEvent(3, detail: "opencode → codex"),
            event(4, kind: "command", title: "Bash", detail: "cargo test"),
            event(5, kind: "usage", title: "Run summary",
                  presentation: TaskEventPresentationSnapshot(type: "usage", costUsd: 0.05, turns: 3)),
        ])
        // First block is the handoff boundary, followed by the current run's blocks.
        guard case .handoff(let boundary) = story.blocks.first else {
            return XCTFail("expected handoff block, got \(String(describing: story.blocks.first))")
        }
        XCTAssertEqual(boundary.earlierRuns.count, 1)
        XCTAssertEqual(boundary.hiddenEventCount, 2) // both pre-handoff events, though they fold to one chapter
        XCTAssertEqual(boundary.chain, "OpenCode → Codex")
        let afterHandoff = story.blocks.dropFirst()
        // The current run has a chapter (event 4) and a receipt (event 5).
        XCTAssertEqual(afterHandoff.count, 2)
        guard case .chapter(_, let rows) = afterHandoff.first else {
            return XCTFail("expected chapter, got \(String(describing: afterHandoff.first))")
        }
        XCTAssertEqual(rows.compactMap { if case .work(let e) = $0 { e.id } else { nil } }, [4])
    }

    /// Three handoffs chain every hop into the collapsed line and hide all
    /// earlier runs.
    func testThreeHandoffsChainAllHops() {
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", detail: "x.rs"),
            handoffEvent(2, detail: "opencode → codex"),
            event(3, kind: "command", title: "Bash", detail: "make"),
            handoffEvent(4, detail: "codex → antigravity"),
            event(5, kind: "file", title: "Edit file", detail: "y.rs"),
            event(6, kind: "command", title: "Bash", detail: "npm test"),
            handoffEvent(7, detail: "antigravity → pi"),
            event(8, kind: "message", title: "Agent message", detail: "done"),
            event(9, kind: "usage", title: "Run summary",
                  presentation: TaskEventPresentationSnapshot(type: "usage", costUsd: 0.12, turns: 2)),
        ])
        guard case .handoff(let boundary) = story.blocks.first else {
            return XCTFail("expected handoff block first, got \(String(describing: story.blocks.first))")
        }
        XCTAssertEqual(boundary.earlierRuns.count, 3)
        XCTAssertEqual(boundary.chain, "OpenCode → Codex → Antigravity → Pi")
        // The current run (after the last handoff) has the message and the receipt.
        let current = story.blocks.dropFirst()
        XCTAssertEqual(current.count, 2)
    }

    /// A malformed handoff detail must not crash — the hop degrades to the raw
    /// string.
    func testMalformedHandoffDetailDoesNotCrash() {
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "ls"),
            handoffEvent(2, detail: "garbage — no arrow here"),
            event(3, kind: "file", title: "Read file", detail: "a.rs"),
        ])
        guard case .handoff(let boundary) = story.blocks.first else {
            return XCTFail("expected handoff block")
        }
        XCTAssertEqual(boundary.earlierRuns.count, 1)
        XCTAssertTrue(boundary.chain.contains("garbage — no arrow here"))
    }

    /// A nil detail on a handoff event must not crash.
    func testNilHandoffDetailDoesNotCrash() {
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "ls"),
            handoffEvent(2, detail: nil),
            event(3, kind: "file", title: "Read file", detail: "a.rs"),
        ])
        guard case .handoff(let boundary) = story.blocks.first else {
            return XCTFail("expected handoff block")
        }
        XCTAssertEqual(boundary.earlierRuns.count, 1)
    }

    /// Expanded view: each earlier run carries the hop that ended it.
    func testEarlierRunsCarryTheirEndingHop() {
        let story = ActivityStory.compose([
            event(1, kind: "file", title: "Read file", detail: "a.rs"),
            handoffEvent(2, detail: "opencode → codex"),
            event(3, kind: "command", title: "Bash", detail: "make"),
            handoffEvent(4, detail: "codex → antigravity"),
            event(5, kind: "message", title: "Agent message", detail: "done"),
        ])
        guard case .handoff(let boundary) = story.blocks.first else {
            return XCTFail("expected handoff block")
        }
        XCTAssertEqual(boundary.earlierRuns.count, 2)
        XCTAssertEqual(boundary.earlierRuns[0].endedBy?.label, "OpenCode → Codex")
        XCTAssertEqual(boundary.earlierRuns[1].endedBy?.label, "Codex → Antigravity")
        XCTAssertEqual(boundary.earlierRuns[0].blocks.count, 1)
        XCTAssertEqual(boundary.earlierRuns[1].blocks.count, 1)
    }

    /// Technical events from earlier runs are collected across all runs.
    func testHandoffCollectsTechnicalFromAllRuns() {
        let story = ActivityStory.compose([
            event(1, kind: "lifecycle", title: "Worker started"),
            event(2, kind: "file", title: "Read file", detail: "a.rs"),
            handoffEvent(3, detail: "opencode → codex"),
            event(4, kind: "lifecycle", title: "Handoff brief built", detail: "verbatim · 1234 chars"),
            event(5, kind: "lifecycle", title: "Worker started"),
            event(6, kind: "command", title: "Bash", detail: "ls"),
        ])
        XCTAssertTrue(story.technical.contains { $0.id == 1 }) // Worker started from run 0
        XCTAssertTrue(story.technical.contains { $0.id == 4 }) // Handoff brief from current run
        XCTAssertTrue(story.technical.contains { $0.id == 5 }) // Worker started from current run
    }
}
