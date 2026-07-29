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
}
