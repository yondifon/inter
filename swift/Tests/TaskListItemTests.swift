import XCTest
@testable import Inter

final class TaskListItemTests: XCTestCase {
    // MARK: - Decoding

    func testDecodesFromSummaryJSON() throws {
        let json = """
        {
            "id": "abc-123",
            "profileId": "worker-1",
            "model": "claude-sonnet-5",
            "cwd": "/Users/malico/desgn/inter",
            "state": "running",
            "promptPreview": "Ship the landing page\\nwith three sections",
            "tldr": "Build a marketing site",
            "title": "Ship the landing page",
            "createdAt": "2026-08-01T10:00:00Z",
            "updatedAt": "2026-08-01T10:05:00Z",
            "error": null,
            "question": null,
            "parentTaskId": null,
            "grantId": null,
            "costUsd": 0.17,
            "archivedAt": null
        }
        """.data(using: .utf8)!
        let item = try JSONDecoder().decode(TaskListItem.self, from: json)
        XCTAssertEqual(item.id, "abc-123")
        XCTAssertEqual(item.profileId, "worker-1")
        XCTAssertEqual(item.model, "claude-sonnet-5")
        XCTAssertEqual(item.state, "running")
        XCTAssertEqual(item.promptPreview, "Ship the landing page\nwith three sections")
        XCTAssertEqual(item.tldr, "Build a marketing site")
        XCTAssertEqual(item.title, "Ship the landing page")
        XCTAssertEqual(item.costUsd, 0.17)
    }

    func testDisplayLabelPrefersTitle() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "m", cwd: "/tmp",
            state: "completed", promptPreview: "Long prompt text\nsecond line",
            tldr: nil, title: "Short label",
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.displayLabel, "Short label")
    }

    func testDisplayLabelFallsBackToPromptPreviewFirstLine() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "m", cwd: "/tmp",
            state: "completed", promptPreview: "Ship the landing page\nwith three sections",
            tldr: nil, title: nil,
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.displayLabel, "Ship the landing page")
    }

    func testDisplayLabelFallsBackToUntitledWhenEverythingIsEmpty() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "m", cwd: "/tmp",
            state: "completed", promptPreview: "",
            tldr: nil, title: "  ",
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.displayLabel, "Untitled task")
    }

    func testHoverTextPrefersTldr() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "m", cwd: "/tmp",
            state: "completed", promptPreview: "Full prompt text",
            tldr: "Short summary",
            title: nil,
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.hoverText, "Short summary")
    }

    func testHoverTextFallsBackToPromptPreview() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "m", cwd: "/tmp",
            state: "completed", promptPreview: "Full prompt text",
            tldr: nil,
            title: nil,
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.hoverText, "Full prompt text")
    }

    func testShortModelStripsProviderPrefix() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "opencode/big-pickle", cwd: "/tmp",
            state: "completed", promptPreview: "p",
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.shortModel, "big-pickle")
    }

    func testShortModelKeepsBareModelUnchanged() {
        let item = TaskListItem(
            id: "1", profileId: "w", model: "sonnet", cwd: "/tmp",
            state: "completed", promptPreview: "p",
            createdAt: "", updatedAt: ""
        )
        XCTAssertEqual(item.shortModel, "sonnet")
    }

    // MARK: - EventMerge — append in order

    private func event(_ id: Int) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: "test", kind: "file", phase: "info",
            title: "Test", detail: nil, presentation: nil, rawText: nil,
            createdAt: "2026-08-01T10:00:00Z"
        )
    }

    func testAppendInOrderAddsOnlyNewEvents() {
        let existing = [event(1), event(2)]
        let incoming = [event(2), event(3), event(4)]
        let fresh = EventMerge.appendInOrder(incoming, after: existing)
        XCTAssertEqual(fresh.map(\.id), [3, 4])
    }

    func testAppendInOrderReturnsEmptyWhenAllAreDuplicates() {
        let existing = [event(1), event(2)]
        let incoming = [event(1), event(2)]
        let fresh = EventMerge.appendInOrder(incoming, after: existing)
        XCTAssertTrue(fresh.isEmpty)
    }

    func testAppendInOrderReturnsEmptyWhenBatchOverlaps() {
        let existing = [event(5), event(6)]
        // incoming has ids that are NOT strictly newer
        let incoming = [event(3), event(4), event(7)]
        let fresh = EventMerge.appendInOrder(incoming, after: existing)
        XCTAssertTrue(fresh.isEmpty, "overlapping batch must signal the caller to sort")
    }

    func testAppendInOrderHandlesEmptyExisting() {
        let incoming = [event(1), event(2)]
        let fresh = EventMerge.appendInOrder(incoming, after: [])
        XCTAssertEqual(fresh.map(\.id), [1, 2])
    }

    func testAppendInOrderHandlesEmptyIncoming() {
        let fresh = EventMerge.appendInOrder([], after: [event(1)])
        XCTAssertTrue(fresh.isEmpty)
    }

    // MARK: - EventMerge — prepend in order

    func testPrependInOrderAddsOnlyNewEvents() {
        let existing = [event(5), event(6)]
        let incoming = [event(2), event(3), event(5)]
        let fresh = EventMerge.prependInOrder(incoming, before: existing)
        XCTAssertEqual(fresh.map(\.id), [2, 3])
    }

    func testPrependInOrderReturnsEmptyWhenAllAreDuplicates() {
        let existing = [event(3), event(4)]
        let incoming = [event(3), event(4)]
        let fresh = EventMerge.prependInOrder(incoming, before: existing)
        XCTAssertTrue(fresh.isEmpty)
    }

    func testPrependInOrderReturnsEmptyWhenBatchOverlaps() {
        let existing = [event(3), event(4)]
        // incoming has id 4 which >= existing.first.id (3)
        let incoming = [event(1), event(4)]
        let fresh = EventMerge.prependInOrder(incoming, before: existing)
        XCTAssertTrue(fresh.isEmpty, "overlapping batch must signal the caller to sort")
    }

    func testPrependInOrderHandlesEmptyExisting() {
        let incoming = [event(1), event(2)]
        let fresh = EventMerge.prependInOrder(incoming, before: [])
        XCTAssertEqual(fresh.map(\.id), [1, 2])
    }

    func testPrependInOrderHandlesEmptyIncoming() {
        let fresh = EventMerge.prependInOrder([], before: [event(1)])
        XCTAssertTrue(fresh.isEmpty)
    }

    // MARK: - End-to-end merge (the caller's responsibility after EventMerge signals)

    func testFullMergeSortsWhenAppendOverlaps() {
        var events = [event(5), event(6)]
        let incoming = [event(3), event(7)]
        let fresh = EventMerge.appendInOrder(incoming, after: events)
        XCTAssertTrue(fresh.isEmpty, "overlap detected")
        // Caller's fallback: dedupe + sort
        let known = Set(events.map(\.id))
        let deduped = incoming.filter { !known.contains($0.id) }
        events.append(contentsOf: deduped)
        events.sort { $0.id < $1.id }
        XCTAssertEqual(events.map(\.id), [3, 5, 6, 7])
    }

    func testFullMergeSortsWhenPrependOverlaps() {
        var events = [event(3), event(4)]
        let incoming = [event(1), event(3)]
        let fresh = EventMerge.prependInOrder(incoming, before: events)
        XCTAssertTrue(fresh.isEmpty, "overlap detected")
        // Caller's fallback: dedupe + sort
        let known = Set(events.map(\.id))
        let deduped = incoming.filter { !known.contains($0.id) }
        events = deduped + events
        events.sort { $0.id < $1.id }
        XCTAssertEqual(events.map(\.id), [1, 3, 4])
    }

    func testBeforePagePrependKeepsAscendingOrder() {
        // Simulates a before-page fetch: 1500 events older than the current oldest.
        let existing = (5000..<6500).map { event($0) }
        let incoming = (3500..<5000).map { event($0) }
        let fresh = EventMerge.prependInOrder(incoming, before: existing)
        XCTAssertEqual(fresh.count, 1500)
        // Verify ascending order: each fresh event's id < existing.first's id
        XCTAssertTrue(fresh.allSatisfy { $0.id < (existing.first?.id ?? Int.max) })
    }
}
