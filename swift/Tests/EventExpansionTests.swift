import XCTest
@testable import Inter

final class EventExpansionTests: XCTestCase {
    private func event(
        kind: String,
        title: String = "Bash",
        detail: String? = nil,
        presentation: TaskEventPresentationSnapshot? = nil,
        rawText: String? = nil
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: 1, taskId: "task", source: "claude", kind: kind, phase: "info",
            title: title, detail: detail, presentation: presentation,
            rawText: rawText, createdAt: "2026-08-03T15:00:00.000Z", minor: nil, actionId: nil
        )
    }

    private let bashPayload = """
    {
      "hook_event_name": "PostToolUse",
      "tool_name": "Bash",
      "tool_input": { "command": "swift test", "timeout": 300000 },
      "tool_response": { "stdout": "Executed 60 tests\\n", "stderr": "warning: no Xcode\\n", "interrupted": false }
    }
    """

    func testCommandRowOpensOnItsCallAndStreams() {
        let row = event(
            kind: "command",
            presentation: TaskEventPresentationSnapshot(type: "command", command: "swift test"),
            rawText: bashPayload
        )
        guard case .command(let command, let output) = EventExpansion(event: row) else {
            return XCTFail("expected a command expansion")
        }
        XCTAssertEqual(command, "swift test")
        XCTAssertEqual(output?.streams, [
            CommandOutput.Stream(isError: false, lines: ["Executed 60 tests"]),
            CommandOutput.Stream(isError: true, lines: ["warning: no Xcode"]),
        ])
    }

    /// A command that printed nothing still has a call worth reading past the
    /// width of the row it sits on.
    func testSilentCommandStillOpensOnItsCall() {
        let row = event(
            kind: "command",
            presentation: TaskEventPresentationSnapshot(type: "command", command: "swift build"),
            rawText: #"{"tool_name":"Bash","tool_input":{"command":"swift build"},"tool_response":{"stdout":""}}"#
        )

        XCTAssertEqual(EventExpansion(event: row), .command("swift build", nil))
    }

    /// OpenCode states the stream on the tool state and again in its metadata.
    func testRepeatedStreamCountsOnce() {
        let output = CommandOutput(rawEvent: """
        {
          "part": { "type": "tool", "tool": "bash", "state": {
            "input": { "command": "git status" },
            "output": "On branch main",
            "metadata": { "output": "On branch main", "exit": 0 }
          } }
        }
        """)

        XCTAssertEqual(output?.streams, [CommandOutput.Stream(isError: false, lines: ["On branch main"])])
    }

    /// `output` is any tool's return value. Without a command in the payload it
    /// is a read's file or a search's matches, not something a shell printed.
    func testOutputWithoutACommandIsNotCommandOutput() {
        XCTAssertNil(CommandOutput(rawEvent: """
        {"part": {"tool": "read", "state": {"input": {"filePath": "/repo/a.ts"}, "output": "1| const a = 1;"}}}
        """))
    }

    func testLongOutputKeepsTheTailAndCountsTheRest() {
        let lines = (1...260).map { "line \($0)" }.joined(separator: "\\n")
        let output = CommandOutput(
            rawEvent: "{\"tool_input\":{\"command\":\"ls\"},\"tool_response\":{\"stdout\":\"\(lines)\"}}"
        )
        let stream = output?.streams.first

        XCTAssertEqual(stream?.lines.count, 200)
        XCTAssertEqual(stream?.lines.first, "line 61")
        XCTAssertEqual(stream?.lines.last, "line 260")
        XCTAssertEqual(stream?.elided, 60)
    }

    func testAgentProseOpensAsItsOwnText() {
        let message = event(
            kind: "message",
            title: "Agent message",
            presentation: TaskEventPresentationSnapshot(type: "message", text: "## Report\n\nDone."),
            rawText: "{\"type\":\"text\",\"part\":{\"text\":\"report\"}}"
        )

        XCTAssertEqual(EventExpansion(event: message), .prose("## Report\n\nDone."))
    }

    /// A thinking ticker is folded into a pulse line, never quoted, so it must
    /// not be routed as prose either.
    func testThinkingTickerIsNotProse() {
        let ticker = event(kind: "reasoning", title: "Thinking", detail: "~400 tokens so far", rawText: "{}")

        XCTAssertEqual(EventExpansion(event: ticker), .payload)
    }

    func testRowWithNothingBetterFallsBackToThePayload() {
        XCTAssertEqual(EventExpansion(event: event(kind: "file", title: "Read file", rawText: """
        {"tool_name": "Read", "tool_input": {"file_path": "/repo/a.ts"}}
        """)), .payload)
    }

    func testDisclosureNamesWhatTheRowOpensInto() {
        XCTAssertEqual(
            EventExpansion.label(for: event(kind: "command", rawText: bashPayload), expanded: false),
            "Show output"
        )
        XCTAssertEqual(
            EventExpansion.label(for: event(kind: "file", rawText: #"{"tool_input":{"old_string":"a","new_string":"b"}}"#), expanded: true),
            "Hide changes"
        )
        XCTAssertEqual(
            EventExpansion.label(for: event(kind: "message", title: "Agent message", detail: "Done"), expanded: false),
            "Show full text"
        )
        XCTAssertEqual(
            EventExpansion.label(for: event(kind: "usage", title: "Usage", rawText: "{}"), expanded: false),
            "Show raw details"
        )
    }

    /// A resumed task carries the reason the caller gave. Even a one-line reason
    /// is more than the row can show, so the disclosure opens on it.
    func testResumeEntryOpensOnTheInstruction() {
        let resumed = event(
            kind: "lifecycle",
            title: "Resumed",
            detail: "Finish the remaining work.",
            rawText: #"{"previousState":"failed","attempt":2,"instruction":"Finish the remaining work."}"#
        )

        XCTAssertEqual(EventExpansion(event: resumed), .detail("Finish the remaining work."))
        XCTAssertTrue(EventExpansion.shouldOfferExpansion(resumed))
        XCTAssertEqual(
            EventExpansion.label(for: resumed, expanded: false),
            "Show why it was resumed"
        )
        XCTAssertEqual(
            EventExpansion.label(for: resumed, expanded: true),
            "Hide why it was resumed"
        )
    }

    /// A multi-line instruction stays whole behind the same disclosure.
    func testMultiLineResumeInstructionIsOffered() {
        let resumed = event(kind: "lifecycle", title: "Resumed", detail: "line one\nline two")

        XCTAssertEqual(EventExpansion(event: resumed), .detail("line one\nline two"))
        XCTAssertTrue(EventExpansion.shouldOfferExpansion(resumed))
    }

    /// A retry-style resume carries no reason, so nothing is hidden behind the
    /// row and no disclosure earns its place.
    func testRetryStyleResumeIsNotExpandable() {
        let retried = event(
            kind: "lifecycle",
            title: "Resumed",
            rawText: #"{"previousState":"failed","attempt":2}"#
        )

        XCTAssertEqual(EventExpansion(event: retried), .payload)
        XCTAssertFalse(EventExpansion.shouldOfferExpansion(retried))
    }

    /// The chevron is a promise that something is hidden. A collapsed row shows
    /// one line, so the offer stands exactly when the expansion holds more than
    /// that line — and never on a row the reader can already see whole.
    func testOfferFollowsWhatTheCollapsedRowCannotShow() {
        // Output the one-line summary cannot carry.
        XCTAssertTrue(EventExpansion.shouldOfferExpansion(event(kind: "command", rawText: bashPayload)))
        // A diff never renders collapsed.
        XCTAssertTrue(EventExpansion.shouldOfferExpansion(event(
            kind: "file",
            rawText: #"{"tool_input":{"old_string":"a","new_string":"b"}}"#
        )))
        // A run of prose past the preview cap keeps its rest reachable.
        XCTAssertTrue(EventExpansion.shouldOfferExpansion(event(
            kind: "message",
            title: "Agent message",
            detail: String(repeating: "line\n", count: 8)
        )))
        // Nothing is hidden behind these, so neither offers.
        XCTAssertFalse(EventExpansion.shouldOfferExpansion(event(
            kind: "message",
            title: "Agent message",
            detail: "Done."
        )))
        XCTAssertFalse(EventExpansion.shouldOfferExpansion(event(kind: "usage", title: "Usage")))
    }
}
