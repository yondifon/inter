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

    /// Every title in the real tool census resolves to the verb its row is
    /// meant to open with, at the kind that title was actually observed
    /// under — the same tool (`Read file`) shows up as both a `file` and a
    /// `tool` kind event across providers, and both must resolve the same
    /// way. A settled run reads in the past tense.
    func testCensusHeadResolvesToVerbs() {
        let cases: [(kind: String, title: String, verb: String)] = [
            ("command", "Bash", "Ran"),
            ("tool", "Bash", "Ran"),
            ("file", "Read file", "Read"),
            ("tool", "Read file", "Read"),
            ("file", "Edit file", "Edited"),
            ("tool", "Edit file", "Edited"),
            ("file", "Write file", "Wrote"),
            ("tool", "Write file", "Wrote"),
            ("tool", "Search code", "Searched"),
            ("tool", "Todo list", "Planned"),
            ("tool", "Find files", "Found"),
            ("tool", "ToolSearch", "Searched"),
            ("tool", "TaskUpdate", "Planned"),
            ("file", "File change", "Changed"),
            ("tool", "Web search", "Searched the web"),
            ("tool", "TaskCreate", "Planned"),
            ("tool", "Fetch page", "Fetched"),
            ("command", "Run Command", "Ran"),
            ("tool", "Subagent", "Delegated"),
            ("tool", "Skill", "Loaded"),
            ("tool", "Node Repl: Js", "Evaluated"),
            ("tool", "Apply patch", "Applied"),
            ("tool", "List Permissions", "Listed"),
        ]
        for (kind, title, verb) in cases {
            XCTAssertEqual(
                ToolIcon.verb(title: title, live: false), verb,
                "\(kind)/\(title) should resolve to \(verb)"
            )
        }
    }

    /// A live run narrates the same rows in the present tense.
    func testLiveRunUsesPresentTense() {
        let cases: [(title: String, verb: String)] = [
            ("Bash", "Running"),
            ("Read file", "Reading"),
            ("Edit file", "Editing"),
            ("Web search", "Searching the web"),
            ("Todo list", "Planning"),
            ("Node Repl: Js", "Evaluating"),
        ]
        for (title, verb) in cases {
            XCTAssertEqual(
                ToolIcon.verb(title: title, live: true), verb,
                "\(title) should resolve to \(verb)"
            )
        }
    }

    /// The normalizer's sentence-case rewrite of the same census titles
    /// resolves to the identical verb as the raw camelCase form.
    func testCorrectedSpellingsResolveTheSameAsRawTitles() {
        let pairs: [(raw: String, corrected: String)] = [
            ("ToolSearch", "Tool search"),
            ("TaskCreate", "Create task"),
            ("TaskUpdate", "Update task"),
            ("Run Command", "Run command"),
            ("List Permissions", "List permissions"),
        ]
        for pair in pairs {
            let rawVerb = ToolIcon.verb(title: pair.raw, live: false)
            let correctedVerb = ToolIcon.verb(title: pair.corrected, live: false)
            XCTAssertNotNil(rawVerb, "\(pair.raw) should resolve")
            XCTAssertEqual(rawVerb, correctedVerb, "\(pair.raw) and \(pair.corrected) should match")
        }
    }

    /// Lookup folds case entirely, independent of the raw/corrected spelling
    /// question above — shouting or whispering the same title changes nothing.
    func testLookupIsCaseInsensitive() {
        XCTAssertEqual(ToolIcon.verb(title: "BASH", live: false), "Ran")
        XCTAssertEqual(ToolIcon.verb(title: "bash", live: false), "Ran")
        XCTAssertEqual(ToolIcon.verb(title: "ReAd FiLe", live: false), "Read")
    }

    /// A title this app never produces gets neither a verb nor a glyph — a
    /// made-up verb would misname the work as surely as a wrong glyph.
    func testUnknownTitleHasNoVerbAndNoIcon() {
        XCTAssertNil(ToolIcon.verb(title: "Frobnicate", live: false))
        XCTAssertNil(ToolIcon.verb(title: "Frobnicate", live: true))
        XCTAssertNil(ToolIcon.symbolName(title: "Frobnicate", kind: "tool"))
        XCTAssertNil(ToolIcon.symbolName(title: "Frobnicate", kind: "file"))
    }

    /// `<server> <function>` and `<server>: <function>` — the two shapes
    /// every MCP call in the stored history actually took — both resolve to
    /// the puzzle-piece glyph regardless of which server is installed. An MCP
    /// call is the one row a word would be worse for: there is no fixed
    /// vocabulary to name, so it keeps no verb.
    func testMCPShapedTitlesHitTheMCPRule() {
        let spaceShaped = ["Inter Tasks", "Inter Memory", "Inter Database Local Query", "GitHub Create Issue"]
        for title in spaceShaped {
            XCTAssertEqual(
                ToolIcon.symbolName(title: title, kind: "tool"), "wrench.adjustable",
                "\(title) should hit the MCP rule"
            )
            XCTAssertNil(ToolIcon.verb(title: title, live: false), "\(title) should have no invented verb")
        }
        let colonShaped = ["Inter [database]: Query", "Inter Database Local: Query", "Slack: Post Message"]
        for title in colonShaped {
            XCTAssertEqual(
                ToolIcon.symbolName(title: title, kind: "tool"), "wrench.adjustable",
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
    /// word — must never be mistaken for the MCP shape: they resolve to their
    /// verb, and to no glyph.
    func testOwnSentenceCaseTitlesResolveToVerbsNotTheMCPRule() {
        XCTAssertNil(ToolIcon.symbolName(title: "Web search", kind: "tool"))
        XCTAssertEqual(ToolIcon.verb(title: "Web search", live: false), "Searched the web")
        XCTAssertNil(ToolIcon.symbolName(title: "Search code", kind: "tool"))
        XCTAssertEqual(ToolIcon.verb(title: "Search code", live: false), "Searched")
    }

    func testConvenienceOverloadsReadTitleAndKindFromTheEvent() {
        XCTAssertEqual(ToolIcon.verb(for: event(kind: "command", title: "Bash"), live: false), "Ran")
        XCTAssertEqual(ToolIcon.verb(for: event(kind: "tool", title: "Bash"), live: true), "Running")
        XCTAssertNil(ToolIcon.verb(for: event(kind: "tool", title: "Frobnicate"), live: false))
        XCTAssertEqual(ToolIcon.symbolName(for: event(kind: "tool", title: "Inter Tasks")), "wrench.adjustable")
        XCTAssertNil(ToolIcon.symbolName(for: event(kind: "tool", title: "Frobnicate")))
    }
}
