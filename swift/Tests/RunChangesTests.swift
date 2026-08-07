import XCTest
@testable import Inter

final class RunChangesTests: XCTestCase {
    private let cwd = "/Users/dev/repo"

    private func collect(_ events: [TaskEventSnapshot]) -> RunChangeSet {
        RunChanges.collect(events, cwd: cwd)
    }

    private func event(
        _ id: Int,
        kind: String = "tool",
        actionId: String? = nil,
        raw: String?
    ) -> TaskEventSnapshot {
        TaskEventSnapshot(
            id: id, taskId: "task", source: "claude", kind: kind, phase: "info",
            title: "Edit", detail: nil, presentation: nil,
            rawText: raw, createdAt: "2026-08-07T00:00:0\(id % 10)Z",
            minor: nil, actionId: actionId
        )
    }

    /// A Claude edit call: the arguments carry the before and after text.
    private func edit(_ path: String, old: String, new: String) -> String {
        """
        {
          "tool_name": "Edit",
          "tool_input": {
            "file_path": "\(path)",
            "old_string": "\(old)",
            "new_string": "\(new)"
          }
        }
        """
    }

    // MARK: - File names

    /// A file inside the run's directory is named from it — the way the reader
    /// refers to it — not by the machine's full route to it.
    func testFileInsideTheRunDirectoryIsNamedFromIt() {
        let set = collect([
            event(1, actionId: "a", raw: edit("\(cwd)/swift/Sources/X.swift", old: "one", new: "ONE")),
        ])

        XCTAssertEqual(set.files.map(\.path), ["swift/Sources/X.swift"])
    }

    /// A file sitting directly in the run's directory is just its name.
    func testFileDirectlyInTheRunDirectoryIsJustItsName() {
        let set = collect([
            event(1, actionId: "a", raw: edit("\(cwd)/filea.txt", old: "one", new: "ONE")),
        ])

        XCTAssertEqual(set.files.map(\.path), ["filea.txt"])
    }

    /// The same file reached absolutely and relatively is one entry, because
    /// both names reduce to the same one.
    func testAbsoluteAndRelativeNamesForOneFileMerge() {
        let set = collect([
            event(1, actionId: "a", raw: edit("\(cwd)/src/store.ts", old: "one", new: "ONE")),
            event(2, actionId: "b", raw: edit("src/store.ts", old: "two", new: "TWO")),
        ])

        XCTAssertEqual(set.files.map(\.path), ["src/store.ts"])
        XCTAssertEqual(set.files.first?.edits, 2)
    }

    /// A path outside the run's directory has no shorter honest name, so it
    /// keeps its own — with home written as `~`.
    func testFileOutsideTheRunDirectoryKeepsItsFullName() {
        XCTAssertEqual(
            DisplayPath.relative(NSHomeDirectory() + "/elsewhere/other.txt", to: cwd),
            "~/elsewhere/other.txt"
        )
        XCTAssertEqual(DisplayPath.relative("/etc/hosts", to: cwd), "/etc/hosts")
    }

    /// A neighbour whose name merely starts with the run's directory is not
    /// inside it — `/repo-backup/x` must not be read as `-backup/x`.
    func testSiblingDirectorySharingAPrefixIsNotTreatedAsInside() {
        XCTAssertEqual(
            DisplayPath.relative("\(cwd)-backup/x.txt", to: cwd),
            "\(cwd)-backup/x.txt"
        )
    }

    /// A trailing slash on the run's directory is the same directory.
    func testTrailingSlashOnTheRunDirectoryIsIgnored() {
        XCTAssertEqual(DisplayPath.relative("\(cwd)/a/b.txt", to: cwd + "/"), "a/b.txt")
    }

    /// With no directory known, a path is left exactly as it arrived.
    func testPathIsLeftAloneWhenTheRunDirectoryIsUnknown() {
        XCTAssertEqual(DisplayPath.relative("/tmp/x.txt", to: ""), "/tmp/x.txt")
    }

    // MARK: - Grouping

    /// The decision this panel is built on: a file edited repeatedly is one
    /// entry holding every hunk, not one entry per call.
    func testRepeatedEditsToOneFileCollapseToOneEntry() {
        let set = collect([
            event(1, actionId: "a", raw: edit("src/store.ts", old: "one", new: "ONE")),
            event(2, actionId: "b", raw: edit("src/store.ts", old: "two", new: "TWO")),
            event(3, actionId: "c", raw: edit("src/store.ts", old: "three", new: "THREE")),
        ])

        XCTAssertEqual(set.files.count, 1)
        XCTAssertEqual(set.files.first?.path, "src/store.ts")
        XCTAssertEqual(set.files.first?.edits, 3)
        XCTAssertEqual(set.files.first?.change.blocks.count, 3)
        XCTAssertEqual(set.files.first?.added, 3)
        XCTAssertEqual(set.files.first?.removed, 3)
    }

    /// Files stack in the order the run first touched them, so the panel reads
    /// as the run happened rather than alphabetically.
    func testFilesKeepFirstTouchOrder() {
        let set = collect([
            event(1, actionId: "a", raw: edit("z.ts", old: "a", new: "b")),
            event(2, actionId: "b", raw: edit("a.ts", old: "c", new: "d")),
            event(3, actionId: "c", raw: edit("z.ts", old: "e", new: "f")),
        ])

        XCTAssertEqual(set.files.map(\.path), ["z.ts", "a.ts"])
        XCTAssertEqual(set.files.first?.edits, 2)
        XCTAssertEqual(set.files.last?.edits, 1)
    }

    /// The same call reaches the trace as an echo, a hook, and a result. Folded
    /// or not, the identical hunk must not stack twice.
    func testTheSameHunkSeenTwiceCountsOnce() {
        let payload = edit("src/store.ts", old: "one", new: "ONE")
        let set = collect([
            event(1, actionId: "same", raw: payload),
            event(2, actionId: "other", raw: payload),
        ])

        XCTAssertEqual(set.files.count, 1)
        XCTAssertEqual(set.files.first?.change.blocks.count, 1)
        XCTAssertEqual(set.files.first?.edits, 1)
        XCTAssertEqual(set.added, 1)
        XCTAssertEqual(set.removed, 1)
    }

    /// Totals are over the whole run, and drive the panel's header line.
    func testRunTotalsSumEveryFile() {
        let set = collect([
            event(1, actionId: "a", raw: edit("a.ts", old: "one", new: "ONE")),
            event(2, actionId: "b", raw: edit("b.ts", old: "two", new: "TWO")),
        ])

        XCTAssertEqual(set.files.count, 2)
        XCTAssertEqual(set.added, 2)
        XCTAssertEqual(set.removed, 2)
    }

    // MARK: - States

    /// A run that changed nothing is empty — the panel says so rather than
    /// drawing a blank list.
    func testRunWithNoEditsIsEmpty() {
        let set = collect([
            event(1, kind: "command", raw: #"{"command": "ls -la"}"#),
            event(2, kind: "message", raw: nil),
        ])

        XCTAssertTrue(set.isEmpty)
        XCTAssertTrue(set.files.isEmpty)
        XCTAssertEqual(set.unmatched, 0)
    }

    /// The panel answers "what did this run change", so a file the run only
    /// opened is not in it. A read carries the file's whole contents — counting
    /// it would report lines the worker never touched, including any the file
    /// was already carrying before the run started.
    func testFileTheRunOnlyReadIsNotListed() {
        let set = collect([
            event(1, kind: "file", actionId: "a", raw: """
            {
              "tool_name": "Read",
              "tool_input": { "file_path": "src/untouched.ts" },
              "tool_response": { "content": "already here\\nbefore the run\\nstarted" }
            }
            """),
        ])

        XCTAssertTrue(set.isEmpty)
        XCTAssertTrue(set.files.isEmpty)
        XCTAssertEqual(set.unmatched, 0)
    }

    /// A change whose payload never named a file cannot join a stack. It is
    /// counted so the panel can admit the list is short.
    func testChangeWithoutAPathIsCountedAsUnmatched() {
        let set = collect([
            event(1, actionId: "a", raw: #"{"tool_input": {"old_string": "x", "new_string": "y"}}"#),
            event(2, actionId: "b", raw: edit("a.ts", old: "one", new: "ONE")),
        ])

        XCTAssertEqual(set.unmatched, 1)
        XCTAssertEqual(set.files.map(\.path), ["a.ts"])
        XCTAssertFalse(set.isEmpty)
    }

    /// A created file arrives as a whole-file write: no before text, and none
    /// of the substrings the cheap gate looks for. The event kind keeps it in.
    func testCreatedFileLandsAsAllAddedLines() {
        let set = collect([
            event(1, kind: "file", actionId: "a", raw: """
            {
              "tool_name": "Write",
              "tool_input": { "file_path": "src/new.ts", "content": "export const a = 1\\nexport const b = 2" }
            }
            """),
        ])

        XCTAssertEqual(set.files.map(\.path), ["src/new.ts"])
        XCTAssertEqual(set.files.first?.added, 2)
        XCTAssertEqual(set.files.first?.removed, 0)
    }

    /// A file emptied out is every line removed and nothing added — the panel
    /// must still list it, with a tally that says so.
    func testDeletedContentLandsAsAllRemovedLines() {
        let set = collect([
            event(1, actionId: "a", raw: edit("src/gone.ts", old: "line one\\nline two", new: "")),
        ])

        XCTAssertEqual(set.files.map(\.path), ["src/gone.ts"])
        XCTAssertEqual(set.files.first?.added, 0)
        XCTAssertEqual(set.files.first?.removed, 2)
    }

    /// Past the cap the tail is counted rather than drawn, and the count is the
    /// real remainder — a heavily edited file must not put thousands of rows
    /// behind one heading.
    func testLongStackIsCappedAndTheRestIsCounted() {
        let events = (1...40).map { index in
            event(index, actionId: "a\(index)", raw: edit(
                "src/big.ts",
                old: (1...20).map { "old \(index)-\($0)" }.joined(separator: "\\n"),
                new: (1...20).map { "new \(index)-\($0)" }.joined(separator: "\\n")
            ))
        }

        let set = collect(events)
        let file = set.files.first

        XCTAssertEqual(set.files.count, 1)
        XCTAssertEqual(file?.edits, 40)
        // Totals span the whole run even though only part of it is drawn.
        XCTAssertEqual(file?.added, 800)
        XCTAssertEqual(file?.removed, 800)
        XCTAssertGreaterThan(file?.hiddenLines ?? 0, 0)

        let drawn = file?.change.blocks.reduce(0) { $0 + $1.count } ?? 0
        XCTAssertEqual(drawn + (file?.hiddenLines ?? 0), 1600)
        // The block that crosses the cap is kept whole, so the drawn count runs
        // past the limit by at most one block.
        XCTAssertGreaterThanOrEqual(drawn, RunChanges.lineLimit)
        XCTAssertLessThan(drawn, RunChanges.lineLimit + 40)
    }

    /// The broker shortens an oversized payload before storing it. The panel
    /// says the diff stops short rather than presenting it as complete.
    func testShortenedPayloadIsFlagged() {
        let set = collect([
            event(1, actionId: "a", raw: edit(
                "src/huge.ts",
                old: "before",
                new: "after …[truncated: kept 6 of 900000 bytes]"
            )),
        ])

        XCTAssertEqual(set.files.first?.shortened, true)
    }

    func testOrdinaryPayloadIsNotFlaggedAsShortened() {
        let set = collect([
            event(1, actionId: "a", raw: edit("src/fine.ts", old: "before", new: "after")),
        ])

        XCTAssertEqual(set.files.first?.shortened, false)
    }
}
