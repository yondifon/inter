import XCTest
@testable import Inter

final class ToolIconTests: XCTestCase {
    private func event(kind: String, title: String) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: 1, taskId: "task", source: "claude", kind: kind, phase: "info",
            title: title, detail: nil, presentation: nil,
            rawText: nil, createdAt: "2026-08-05T15:00:00.000Z", minor: nil, actionId: nil
        )
    }

    /// Every title in the real tool census resolves to the glyph its row is
    /// meant to carry, at the kind that title was actually observed under —
    /// the same tool (`Read file`) shows up as both a `file` and a `tool`
    /// kind event across providers, and both must resolve the same way.
    func testCensusHeadResolves() {
        let cases: [(kind: String, title: String, symbol: String)] = [
            ("command", "Bash", "terminal"),
            ("tool", "Bash", "terminal"),
            ("file", "Read file", "doc.text"),
            ("tool", "Read file", "doc.text"),
            ("file", "Edit file", "square.and.pencil"),
            ("tool", "Edit file", "square.and.pencil"),
            ("file", "Write file", "doc.badge.plus"),
            ("tool", "Write file", "doc.badge.plus"),
            ("tool", "Search code", "text.magnifyingglass"),
            ("tool", "Todo list", "checklist"),
            ("tool", "Find files", "folder.badge.questionmark"),
            ("tool", "ToolSearch", "magnifyingglass"),
            ("tool", "TaskUpdate", "list.clipboard"),
            ("file", "File change", "doc.badge.plus"),
            ("tool", "Web search", "globe"),
            ("tool", "TaskCreate", "list.clipboard"),
            ("tool", "Fetch page", "arrow.down.doc"),
            ("command", "Run Command", "terminal"),
            ("tool", "Subagent", "person.2"),
            ("tool", "Skill", "wand.and.stars"),
            ("tool", "Node Repl: Js", "chevron.left.forwardslash.chevron.right"),
            ("tool", "Apply patch", "bandage"),
            ("tool", "List Permissions", "checkmark.shield"),
        ]
        for (kind, title, symbol) in cases {
            XCTAssertEqual(
                ToolIcon.symbolName(title: title, kind: kind), symbol,
                "\(kind)/\(title) should resolve to \(symbol)"
            )
        }
    }

    /// The normalizer's sentence-case rewrite of the same census titles
    /// resolves to the identical glyph as the raw camelCase form.
    func testCorrectedSpellingsResolveTheSameAsRawTitles() {
        let pairs: [(raw: String, corrected: String)] = [
            ("ToolSearch", "Tool search"),
            ("TaskCreate", "Create task"),
            ("TaskUpdate", "Update task"),
            ("Run Command", "Run command"),
            ("List Permissions", "List permissions"),
        ]
        for pair in pairs {
            let rawSymbol = ToolIcon.symbolName(title: pair.raw, kind: "tool")
            let correctedSymbol = ToolIcon.symbolName(title: pair.corrected, kind: "tool")
            XCTAssertNotNil(rawSymbol, "\(pair.raw) should resolve")
            XCTAssertEqual(rawSymbol, correctedSymbol, "\(pair.raw) and \(pair.corrected) should match")
        }
    }

    /// Lookup folds case entirely, independent of the raw/corrected spelling
    /// question above — shouting or whispering the same title changes nothing.
    func testLookupIsCaseInsensitive() {
        XCTAssertEqual(ToolIcon.symbolName(title: "BASH", kind: "command"), "terminal")
        XCTAssertEqual(ToolIcon.symbolName(title: "bash", kind: "command"), "terminal")
        XCTAssertEqual(ToolIcon.symbolName(title: "ReAd FiLe", kind: "file"), "doc.text")
    }

    /// A title this app never produces, with no MCP shape either, keeps its
    /// text — the fallback that protects a reader from a wrong or generic
    /// glyph standing in for a tool that was never identified.
    func testUnknownTitleHasNoIcon() {
        XCTAssertNil(ToolIcon.symbolName(title: "Frobnicate", kind: "tool"))
        XCTAssertNil(ToolIcon.symbolName(title: "Frobnicate", kind: "file"))
    }

    /// `<server> <function>` and `<server>: <function>` — the two shapes
    /// every MCP call in the stored history actually took — both resolve to
    /// the puzzle-piece glyph regardless of which server is installed.
    func testMCPShapedTitlesHitTheMCPRule() {
        let spaceShaped = ["Inter Tasks", "Inter Memory", "Inter Database Local Query", "GitHub Create Issue"]
        for title in spaceShaped {
            XCTAssertEqual(
                ToolIcon.symbolName(title: title, kind: "tool"), "puzzlepiece.extension",
                "\(title) should hit the MCP rule"
            )
        }
        let colonShaped = ["Inter [database]: Query", "Inter Database Local: Query", "Slack: Post Message"]
        for title in colonShaped {
            XCTAssertEqual(
                ToolIcon.symbolName(title: title, kind: "tool"), "puzzlepiece.extension",
                "\(title) should hit the MCP rule"
            )
        }
    }

    /// MCP shape alone isn't enough — the fallback only fires for `"tool"`
    /// kind events, because a `"file"`/`"command"` row already carries a
    /// path or command line that a puzzle piece would only obscure.
    func testMCPRuleOnlyAppliesToToolKind() {
        XCTAssertNil(ToolIcon.symbolName(title: "Inter Database Local Query", kind: "file"))
        XCTAssertNil(ToolIcon.symbolName(title: "Inter Database Local Query", kind: "command"))
    }

    /// The app's own sentence-case titles — capitalized only on their first
    /// word — must never be mistaken for the MCP shape and lose their exact
    /// glyph to the generic puzzle piece.
    func testOwnSentenceCaseTitlesDoNotTripTheMCPRule() {
        XCTAssertEqual(ToolIcon.symbolName(title: "Web search", kind: "tool"), "globe")
        XCTAssertEqual(ToolIcon.symbolName(title: "Search code", kind: "tool"), "text.magnifyingglass")
    }

    func testConvenienceOverloadReadsTitleAndKindFromTheEvent() {
        XCTAssertEqual(ToolIcon.symbolName(for: event(kind: "command", title: "Bash")), "terminal")
        XCTAssertNil(ToolIcon.symbolName(for: event(kind: "tool", title: "Frobnicate")))
    }
}
