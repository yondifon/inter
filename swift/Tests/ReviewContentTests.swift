import XCTest
@testable import Inter

final class ReviewContentTests: XCTestCase {
    func testParsesCommonReviewMarkdownBlocks() {
        let source = """
        ## Changed

        - `src/cli.ts`
        - **Tests:** pass

        | Check | Result |
        | --- | --- |
        | Tests | 6 pass |

        ```sh
        bun test
        ```
        """

        XCTAssertEqual(MarkdownParser.parse(source), [
            .heading(level: 2, text: "Changed"),
            .unorderedList(["`src/cli.ts`", "**Tests:** pass"]),
            .table(headers: ["Check", "Result"], rows: [["Tests", "6 pass"]]),
            .code(language: "sh", text: "bun test"),
        ])
    }

    func testDetectsJSONBeforeMarkdown() {
        XCTAssertEqual(
            ReviewContent(#"{"ok":true,"items":[{"name":"one"}]}"#),
            .json(.object([
                "ok": .boolean(true),
                "items": .array([.object(["name": .string("one")])]),
            ]))
        )
    }

    func testInvalidJSONFallsBackToReadableText() {
        XCTAssertEqual(
            ReviewContent(#"{"still":"streaming""#),
            .markdown([.paragraph(#"{"still":"streaming""#)])
        )
    }

    func testRunningTaskOpensActivity() {
        XCTAssertEqual(TaskDetailSection.initial(for: task(state: "running")), .activity)
    }

    func testCompletedTaskWithOutputOpensResponse() {
        XCTAssertEqual(
            TaskDetailSection.initial(for: task(state: "completed", output: "Done")),
            .response
        )
    }

    func testTaskWithoutOutputOpensActivity() {
        XCTAssertEqual(TaskDetailSection.initial(for: task(state: "failed")), .activity)
    }

    func testOnlyKnownProtocolEventsAreTechnicalNoise() {
        XCTAssertEqual(technicalIDs(event(kind: "raw", title: "Step Start")), [1])
        XCTAssertEqual(technicalIDs(event(kind: "lifecycle", title: "Heartbeat")), [1])
        XCTAssertEqual(technicalIDs(event(kind: "raw", title: "Unknown provider event")), [])
        XCTAssertEqual(
            technicalIDs(event(kind: "lifecycle", title: "Heartbeat", detail: "No agent event for 35s")),
            []
        )
    }

    private func technicalIDs(_ event: TaskEventSnapshot) -> [Int] {
        ActivityStory.compose([event]).technical.map(\.id)
    }

    private func task(state: String, output: String = "") -> TaskSnapshot {
        TaskSnapshot(
            id: "task-1",
            profileId: "worker-1",
            model: "model",
            prompt: "Prompt",
            cwd: "/tmp",
            state: state,
            createdAt: "2026-07-29T00:00:00Z",
            updatedAt: "2026-07-29T00:00:00Z",
            output: output
        )
    }

    private func event(kind: String, title: String, detail: String? = nil) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: 1,
            taskId: "task-1",
            source: "broker",
            kind: kind,
            phase: "info",
            title: title,
            detail: detail,
            createdAt: "2026-07-29T20:53:19.854Z"
        )
    }
}
