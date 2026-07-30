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
        createdAt: String = "2026-07-30T15:00:00.000Z"
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: source, kind: kind, phase: phase,
            title: title, detail: detail, presentation: presentation,
            rawText: nil, createdAt: createdAt
        )
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

    func testOnlyFinalUsageEventBecomesTheReceipt() {
        let turn = TaskEventPresentationSnapshot(type: "usage", tokensOut: 104)
        let final = TaskEventPresentationSnapshot(type: "usage", costUsd: 0.17, turns: 2)
        let story = ActivityStory.compose([
            event(1, kind: "usage", title: "Turn completed", presentation: turn),
            event(2, kind: "message", title: "Agent message", detail: "done"),
            event(3, kind: "usage", title: "Run summary", presentation: final),
        ])
        XCTAssertEqual(story.technical.map(\.id), [1])
        guard case .receipt(let receipt) = story.blocks.last else {
            return XCTFail("expected trailing receipt, got \(String(describing: story.blocks.last))")
        }
        XCTAssertEqual(receipt.id, 3)
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
