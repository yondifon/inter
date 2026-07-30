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
        guard case .chapter(_, let rows) = story.blocks.first else {
            return XCTFail("expected one chapter, got \(story.blocks)")
        }
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
        guard case .chapter(_, let rows) = story.blocks.first else {
            return XCTFail("expected one chapter, got \(story.blocks)")
        }
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
        guard case .chapter(_, let rows) = story.blocks.first else {
            return XCTFail("expected one chapter, got \(story.blocks)")
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].phase, "failed")
        XCTAssertNil(rows[0].presentation?.outcome)
        XCTAssertEqual(rows[0].detail, "…/kii/AGENTS.md · \(error)")
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
        XCTAssertEqual(story.blocks.count, 3)
        guard case .reasoning(let pulse) = story.blocks[1] else {
            return XCTFail("expected reasoning pulse, got \(story.blocks[1])")
        }
        XCTAssertEqual(pulse.detail, "~5.3k tokens")
        XCTAssertEqual(pulse.updates, 2)
        XCTAssertEqual(pulse.seconds, 46)
    }

    func testCollapsesHookAndEchoRowsOfOneAction() {
        let done = TaskEventPresentationSnapshot(type: "command", command: "bun test", exitCode: 0)
        let story = ActivityStory.compose([
            event(1, kind: "command", title: "Bash", detail: "bun test", phase: "started"),
            event(2, kind: "command", title: "Bash", detail: "bun test", phase: "completed"),
            event(3, kind: "command", title: "Bash", detail: "bun test", phase: "completed", presentation: done),
            event(4, kind: "file", title: "Read file", detail: "src/a.ts"),
        ])
        guard case .chapter(_, let rows) = story.blocks[0] else {
            return XCTFail("expected chapter, got \(story.blocks[0])")
        }
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
        guard case .chapter(_, let events) = story.blocks.first else {
            return XCTFail("expected chapter, got \(String(describing: story.blocks.first))")
        }
        XCTAssertEqual(events.map(\.id), [3])
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
        guard case .chapter(_, let events) = story.blocks[0] else {
            return XCTFail("expected one chapter, got \(story.blocks)")
        }
        XCTAssertEqual(events.map(\.id), [1, 2])
    }
}
