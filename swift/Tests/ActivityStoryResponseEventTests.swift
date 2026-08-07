import XCTest
@testable import Inter

final class ActivityStoryResponseEventTests: XCTestCase {
    private func event(
        _ id: Int,
        kind: String,
        detail: String? = nil,
        minor: Bool? = nil
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: "claude", kind: kind, phase: "info",
            title: kind, detail: detail, presentation: nil,
            rawText: nil, createdAt: "2026-08-07T00:00:0\(id % 10)Z",
            minor: minor, actionId: nil
        )
    }

    /// The response is the worker's closing message, not whatever event
    /// happens to land last — a usage receipt or a lifecycle row commonly
    /// follows it.
    func testFindsLastMessageEvenWhenLaterEventsFollow() {
        let events = [
            event(1, kind: "tool"),
            event(2, kind: "message", detail: "Here's what I found."),
            event(3, kind: "usage"),
            event(4, kind: "lifecycle", detail: "Task completed"),
        ]
        XCTAssertEqual(ActivityStory.responseEvent(in: events)?.id, 2)
    }

    /// The latest message wins when a run produced more than one — e.g. a
    /// resumed task that answered a question earlier in the same trace.
    func testFindsTheLastOfSeveralMessages() {
        let events = [
            event(1, kind: "message", detail: "First update."),
            event(2, kind: "tool"),
            event(3, kind: "message", detail: "Final answer."),
        ]
        XCTAssertEqual(ActivityStory.responseEvent(in: events)?.id, 3)
    }

    /// A message marked `minor` is a protocol echo folded into the technical
    /// list, never shown as a row — it cannot be the row the pane scrolls to.
    func testSkipsMinorMessages() {
        let events = [
            event(1, kind: "message", detail: "Real answer."),
            event(2, kind: "message", detail: "Echo.", minor: true),
        ]
        XCTAssertEqual(ActivityStory.responseEvent(in: events)?.id, 1)
    }

    /// A run cancelled before producing any output — the caller must fall
    /// back to today's open behaviour rather than scroll to nothing.
    func testNilWhenNoMessageEventExists() {
        let events = [
            event(1, kind: "tool"),
            event(2, kind: "lifecycle", detail: "Task cancelled"),
        ]
        XCTAssertNil(ActivityStory.responseEvent(in: events))
    }

    func testNilForEmptyTrace() {
        XCTAssertNil(ActivityStory.responseEvent(in: []))
    }
}
