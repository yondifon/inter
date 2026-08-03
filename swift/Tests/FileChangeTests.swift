import XCTest
@testable import Inter

final class FileChangeTests: XCTestCase {
    private func change(_ json: String) -> FileChange? {
        FileChange(rawEvent: json)
    }

    /// The hook carries the call and its result. The call's arguments are the
    /// change; the result must not repeat it as a second block.
    func testClaudeEditHookYieldsOneBlockFromTheCall() {
        let change = change("""
        {
          "hook_event_name": "PostToolUse",
          "tool_name": "Edit",
          "tool_input": {
            "file_path": "/repo/internal/repo/agents.go",
            "old_string": "if lastRunAt.Valid {\\n\\ta.LastRunAt = parseTime(lastRunAt.String)\\n}",
            "new_string": "if lastRunAt.Valid {\\n\\ta.LastRunAt = parseSQLiteTime(lastRunAt.String)\\n}"
          },
          "tool_response": {
            "filePath": "/repo/internal/repo/agents.go",
            "structuredPatch": [{ "lines": [" if lastRunAt.Valid {", "-\\ta.LastRunAt = parseTime(x)"] }]
          }
        }
        """)

        XCTAssertEqual(change?.path, "/repo/internal/repo/agents.go")
        XCTAssertEqual(change?.blocks.count, 1)
        XCTAssertEqual(change?.blocks.first, [
            DiffLine(kind: .context, text: "if lastRunAt.Valid {"),
            DiffLine(kind: .removed, text: "\ta.LastRunAt = parseTime(lastRunAt.String)"),
            DiffLine(kind: .added, text: "\ta.LastRunAt = parseSQLiteTime(lastRunAt.String)"),
            DiffLine(kind: .context, text: "}"),
        ])
        XCTAssertEqual(change?.added, 1)
        XCTAssertEqual(change?.removed, 1)
    }

    /// OpenCode nests the same arguments three levels down under its own names.
    func testOpenCodeEditIsFoundThroughItsNesting() {
        let change = change("""
        {
          "part": {
            "type": "tool",
            "tool": "edit",
            "state": {
              "status": "completed",
              "input": {
                "filePath": "/repo/index.html",
                "oldString": "<strong>03</strong>",
                "newString": "<strong>02</strong>"
              }
            }
          }
        }
        """)

        XCTAssertEqual(change?.path, "/repo/index.html")
        XCTAssertEqual(change?.blocks.first, [
            DiffLine(kind: .removed, text: "<strong>03</strong>"),
            DiffLine(kind: .added, text: "<strong>02</strong>"),
        ])
    }

    func testMultiEditKeepsOneBlockPerReplacementInOrder() {
        let change = change("""
        {
          "tool_name": "MultiEdit",
          "tool_input": {
            "file_path": "/repo/app.ts",
            "edits": [
              { "old_string": "let a = 1;", "new_string": "let a = 2;" },
              { "old_string": "debugger;", "new_string": "" }
            ]
          }
        }
        """)

        XCTAssertEqual(change?.path, "/repo/app.ts")
        XCTAssertEqual(change?.blocks, [
            [DiffLine(kind: .removed, text: "let a = 1;"), DiffLine(kind: .added, text: "let a = 2;")],
            [DiffLine(kind: .removed, text: "debugger;")],
        ])
    }

    /// A write has no before text; its content is what the file became.
    func testWriteContentReadsAsAddedLines() {
        let change = change("""
        {
          "tool_name": "Write",
          "tool_input": { "file_path": "/repo/new.ts", "content": "export const a = 1;\\nexport const b = 2;\\n" }
        }
        """)

        XCTAssertEqual(change?.blocks.first, [
            DiffLine(kind: .added, text: "export const a = 1;"),
            DiffLine(kind: .added, text: "export const b = 2;"),
        ])
    }

    /// A read's response carries the whole file. Nothing changed, so nothing is
    /// shown — the payload tree stays the answer for that row.
    func testReadPayloadProducesNoChange() {
        XCTAssertNil(change("""
        {
          "hook_event_name": "PostToolUse",
          "tool_name": "Read",
          "tool_input": { "file_path": "/repo/app.ts" },
          "tool_response": { "file": { "filePath": "/repo/app.ts", "content": "line one\\nline two", "numLines": 2 } }
        }
        """))
    }

    /// When the payload kept the result but not the call, the applied patch is
    /// the only record of the change — and it brings real surrounding lines.
    func testStructuredPatchIsUsedWhenTheCallIsMissing() {
        let change = change("""
        {
          "tool_response": {
            "filePath": "/repo/app.ts",
            "structuredPatch": [
              { "oldStart": 4, "lines": [" const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;"] }
            ]
          }
        }
        """)

        XCTAssertEqual(change?.path, "/repo/app.ts")
        XCTAssertEqual(change?.blocks.first, [
            DiffLine(kind: .context, text: "const a = 1;"),
            DiffLine(kind: .removed, text: "const b = 2;"),
            DiffLine(kind: .added, text: "const b = 3;"),
            DiffLine(kind: .context, text: "const c = 4;"),
        ])
    }

    func testUnchangedStretchesBetweenChangesCollapse() {
        let before = (1...20).map { "line \($0)" }.joined(separator: "\n")
        let after = before
            .replacingOccurrences(of: "line 1\n", with: "line one\n")
            .replacingOccurrences(of: "line 20", with: "line twenty")
        let lines = FileChange.diff(old: before, new: after)

        XCTAssertEqual(lines.filter { $0.kind == .skipped }, [
            DiffLine(kind: .skipped, text: "12 unchanged lines"),
        ])
        XCTAssertEqual(lines.first, DiffLine(kind: .removed, text: "line 1"))
        XCTAssertEqual(lines.last, DiffLine(kind: .added, text: "line twenty"))
    }

    /// Alternating one removal with one addition reads as noise; a replaced
    /// block reads as a block.
    func testRunsListRemovalsBeforeAdditions() {
        let lines = FileChange.diff(old: "a\nb\nkeep", new: "x\ny\nkeep")

        XCTAssertEqual(lines, [
            DiffLine(kind: .removed, text: "a"),
            DiffLine(kind: .removed, text: "b"),
            DiffLine(kind: .added, text: "x"),
            DiffLine(kind: .added, text: "y"),
            DiffLine(kind: .context, text: "keep"),
        ])
    }

    func testEmptyReplacementIsADeletionWithNoBlankLine() {
        XCTAssertEqual(FileChange.diff(old: "debugger;\n", new: ""), [
            DiffLine(kind: .removed, text: "debugger;"),
        ])
    }

    func testEditMarkersAreDetectedBeforeParsing() {
        XCTAssertTrue(FileChange.mayContainEdit(#"{"tool_input":{"old_string":"a","new_string":"b"}}"#))
        XCTAssertTrue(FileChange.mayContainEdit(#"{"oldString":"a","newString":"b"}"#))
        XCTAssertFalse(FileChange.mayContainEdit(#"{"tool_input":{"file_path":"/repo/app.ts"}}"#))
    }

    /// pi sends no before/after arguments at all — the unified diff in the
    /// result is the only description of the edit. Payload taken verbatim from
    /// a real run.
    func testPiEditIsRecoveredFromItsUnifiedPatch() {
        let change = change("""
        {
          "type": "tool_execution_end",
          "toolCallId": "call_00_ET_cXKG83rh3W2xE4MBUbuv5571",
          "toolName": "edit",
          "result": {
            "content": [{ "type": "text", "text": "Successfully replaced 1 block(s) in .inter-test/pi-diff.txt." }],
            "details": {
              "diff": "-1 status: before\\n+1 status: after",
              "patch": "--- .inter-test/pi-diff.txt\\n+++ .inter-test/pi-diff.txt\\n@@ -1,1 +1,1 @@\\n-status: before\\n+status: after\\n",
              "firstChangedLine": 1
            }
          },
          "isError": false
        }
        """)

        XCTAssertEqual(change?.path, ".inter-test/pi-diff.txt")
        XCTAssertEqual(change?.blocks.count, 1)
        XCTAssertEqual(change?.blocks.first, [
            DiffLine(kind: .removed, text: "status: before"),
            DiffLine(kind: .added, text: "status: after"),
        ])
        XCTAssertEqual(change?.added, 1)
        XCTAssertEqual(change?.removed, 1)
    }

    /// The gate decides whether a row is even parsed for a diff.
    func testUnifiedDiffMarkerOpensTheChangesTab() {
        XCTAssertTrue(FileChange.mayContainEdit(#"{"patch":"@@ -1,1 +1,1 @@"}"#))
        XCTAssertFalse(FileChange.mayContainEdit(#"{"text":"apply the patch when ready"}"#))
    }
}
