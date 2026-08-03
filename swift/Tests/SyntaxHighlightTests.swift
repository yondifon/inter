import XCTest
@testable import Inter

final class SyntaxHighlightTests: XCTestCase {
    func testNamesLanguageFromFenceAndPath() {
        XCTAssertEqual(CodeLanguage(fence: "ts"), .cFamily)
        XCTAssertEqual(CodeLanguage(fence: "bash title=run"), .hashFamily)
        XCTAssertEqual(CodeLanguage(fence: nil), .none)
        XCTAssertEqual(CodeLanguage(fence: "mermaid"), .none)
        XCTAssertEqual(CodeLanguage(path: "src/cli.ts"), .cFamily)
        XCTAssertEqual(CodeLanguage(path: "/repo/Makefile"), .hashFamily)
        XCTAssertEqual(CodeLanguage(path: "inter.config.json"), .json)
        XCTAssertEqual(CodeLanguage(path: "README"), .none)
    }

    func testSplitsCodeIntoComponentsWithoutLosingText() {
        let source = """
        // count the runs
        let total = 12 + width
        """
        let spans = SyntaxHighlighter.spans(source, language: .cFamily)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertEqual(spans.first, CodeSpan(kind: .comment, text: "// count the runs"))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "let")))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .number, text: "12")))
        XCTAssertFalse(spans.contains { $0.kind == .keyword && $0.text == "total" })
    }

    func testReadsStringsAndTheirEscapes() {
        let spans = SyntaxHighlighter.spans(#"run("a \"b\" c", 3)"#, language: .cFamily)
        XCTAssertTrue(spans.contains(CodeSpan(kind: .string, text: #""a \"b\" c""#)))
    }

    func testUnterminatedQuoteStopsAtTheLine() {
        let source = """
        echo it's fine
        export KEY=1
        """
        let spans = SyntaxHighlighter.spans(source, language: .hashFamily)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "export")))
    }

    func testDigitsInsideNamesAreNotLiterals() {
        let spans = SyntaxHighlighter.spans("let utf8 = 0..<10", language: .cFamily)
        XCTAssertEqual(spans.map(\.text).joined(), "let utf8 = 0..<10")
        XCTAssertEqual(spans.filter { $0.kind == .number }.map(\.text), ["0", "10"])
    }

    func testUnknownLanguageIsLeftAlone() {
        XCTAssertEqual(
            SyntaxHighlighter.spans("plain # text", language: .none),
            [CodeSpan(kind: .plain, text: "plain # text")]
        )
    }
}
