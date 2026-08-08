import XCTest
@testable import Inter

final class SyntaxHighlightTests: XCTestCase {
    func testNamesLanguageFromFenceAndPath() {
        XCTAssertEqual(CodeLanguage(fence: "ts"), .cFamily)
        XCTAssertEqual(CodeLanguage(fence: "swift"), .cFamily)
        XCTAssertEqual(CodeLanguage(fence: "bash title=run"), .hashFamily)
        XCTAssertEqual(CodeLanguage(fence: "toml"), .hashFamily)
        XCTAssertEqual(CodeLanguage(fence: "md"), .markdown)
        XCTAssertEqual(CodeLanguage(fence: nil), .none)
        XCTAssertEqual(CodeLanguage(fence: "mermaid"), .none)
        XCTAssertEqual(CodeLanguage(path: "src/cli.ts"), .cFamily)
        XCTAssertEqual(CodeLanguage(path: "swift/Sources/DesignSystem.swift"), .cFamily)
        XCTAssertEqual(CodeLanguage(path: "/repo/Makefile"), .hashFamily)
        XCTAssertEqual(CodeLanguage(path: "Cargo.toml"), .hashFamily)
        XCTAssertEqual(CodeLanguage(path: "inter.config.json"), .json)
        XCTAssertEqual(CodeLanguage(path: "docs/README.md"), .markdown)
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

    func testHighlightsJSONLiteralsAndStrings() {
        let source = #"{"ok": true, "count": 3, "name": "inter"}"#
        let spans = SyntaxHighlighter.spans(source, language: .json)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "true")))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .number, text: "3")))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .string, text: #""inter""#)))
    }

    func testHighlightsTOMLCommentsStringsAndBooleans() {
        let source = """
        # config
        name = "inter"
        debug = true
        """
        let spans = SyntaxHighlighter.spans(source, language: CodeLanguage(fence: "toml"))

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertEqual(spans.first, CodeSpan(kind: .comment, text: "# config"))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .string, text: #""inter""#)))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "true")))
    }

    func testHighlightsMarkdownHeadingsAndInlineCodeButNotDigitsInProse() {
        let source = """
        # Title
        Released in 2024, see `inter.config.json` for details.
        """
        let spans = SyntaxHighlighter.spans(source, language: .markdown)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertEqual(spans.first, CodeSpan(kind: .keyword, text: "# Title"))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .string, text: "`inter.config.json`")))
        XCTAssertFalse(spans.contains { $0.kind == .number })
    }

    func testMarkdownHeadingNeedsASpaceAfterAtMostSixHashes() {
        let spans = SyntaxHighlighter.spans("#nope\n####### also not a heading", language: .markdown)

        XCTAssertEqual(spans.map(\.text).joined(), "#nope\n####### also not a heading")
        XCTAssertFalse(spans.contains { $0.kind == .keyword })
    }

    func testUnterminatedBlockCommentReachesEndOfFileWithoutLosingText() {
        let source = """
        let a = 1
        /* never closes
        let b = 2
        """
        let spans = SyntaxHighlighter.spans(source, language: .cFamily)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertEqual(spans.last?.kind, .comment)
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "let")))
    }

    func testUnterminatedBacktickTemplateReachesEndOfFileWithoutLosingText() {
        let source = """
        let a = `never closes
        still inside it
        """
        let spans = SyntaxHighlighter.spans(source, language: .cFamily)

        XCTAssertEqual(spans.map(\.text).joined(), source)
        XCTAssertEqual(spans.last?.kind, .string)
    }

    func testCommentLookalikeInsideAStringStaysAString() {
        let spans = SyntaxHighlighter.spans(#"let msg = "see // this # too""#, language: .cFamily)

        XCTAssertTrue(spans.contains(CodeSpan(kind: .string, text: #""see // this # too""#)))
        XCTAssertFalse(spans.contains { $0.kind == .comment })
    }

    func testCapitalisedNamesReadAsTypesInCFamilyOnly() {
        let cSpans = SyntaxHighlighter.spans("let items: Array<String> = URLSession.shared", language: .cFamily)
        XCTAssertTrue(cSpans.contains(CodeSpan(kind: .type, text: "Array")))
        XCTAssertTrue(cSpans.contains(CodeSpan(kind: .type, text: "String")))
        XCTAssertTrue(cSpans.contains(CodeSpan(kind: .type, text: "URLSession")))

        let shellSpans = SyntaxHighlighter.spans("export HOME=/root", language: .hashFamily)
        XCTAssertFalse(shellSpans.contains { $0.kind == .type })
    }

    func testPythonCapitalisedLiteralsAreKeywords() {
        let spans = SyntaxHighlighter.spans("ready = True if value is None else False", language: .hashFamily)

        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "True")))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "None")))
        XCTAssertTrue(spans.contains(CodeSpan(kind: .keyword, text: "False")))
    }

    func testEmptyInputProducesNoSpans() {
        XCTAssertEqual(SyntaxHighlighter.spans("", language: .cFamily), [])
        XCTAssertEqual(SyntaxHighlighter.spans("", language: .none), [])
    }

    func testHighlightedCachesByExactTextAndLanguage() {
        let a = CodeStyle.highlighted("let x = 1", language: .cFamily)
        let b = CodeStyle.highlighted("let x = 1", language: .cFamily)
        let c = CodeStyle.highlighted("let x = 1", language: .hashFamily)

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }
}
