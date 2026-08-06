import XCTest

@testable import Inter

final class TaskGroupingTests: XCTestCase {
    private func item(_ id: String, cwd: String, parent: String? = nil, promptPreview: String = "prompt", title: String? = nil, state: String = "completed", updatedAt: String = "2026-07-29T10:00:00Z") -> TaskListItem {
        TaskListItem(
            id: id,
            profileId: "worker",
            model: "sonnet",
            cwd: cwd,
            state: state,
            promptPreview: promptPreview,
            tldr: nil,
            title: title,
            createdAt: "2026-07-29T10:00:00Z",
            updatedAt: updatedAt,
            error: nil,
            question: nil,
            parentTaskId: parent
        )
    }

    private let inter = "/Users/dev/desgn/inter"
    private let site = "/Users/dev/work/site"

    func testProjectsCountTasksInFirstSeenOrder() {
        let projects = TaskOrganizer.projects(in: [
            item("1", cwd: inter),
            item("2", cwd: site),
            item("3", cwd: inter),
        ])
        XCTAssertEqual(projects.map(\.name), ["inter", "site"])
        XCTAssertEqual(projects.map(\.count), [2, 1])
        XCTAssertEqual(projects.first?.id, inter, "the full path is the identity, not the folder name")
    }

    func testFilterKeepsOnlyTheSelectedProject() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter), item("2", cwd: site), item("3", cwd: inter)],
            project: inter,
            grouping: .project
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].title, "inter")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"])
    }

    func testGroupingNothingReturnsOneUntitledRun() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter), item("2", cwd: site)],
            project: nil,
            grouping: .none
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertNil(groups[0].title, "an ungrouped list carries no heading")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "2"])
    }

    func testStaleFilterFallsBackToEveryTask() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter)],
            project: "/Users/dev/deleted-checkout",
            grouping: .none
        )
        XCTAssertEqual(
            groups[0].tasks.map(\.id), ["1"],
            "a saved filter for a project with no tasks must not strand the sidebar empty"
        )
        XCTAssertNil(TaskOrganizer.activeProjectName(tasks: [item("1", cwd: inter)], project: "/gone"))
    }

    func testGroupingPreservesTaskOrderWithinEachProject() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter),
                item("2", cwd: site),
                item("3", cwd: inter),
            ],
            project: nil,
            grouping: .project
        )
        XCTAssertEqual(groups.map(\.title), ["inter", "site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"])
        XCTAssertEqual(groups[1].tasks.map(\.id), ["2"])
    }

    func testFilterAndGroupingCombine() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter), item("2", cwd: site)],
            project: site,
            grouping: .project
        )
        XCTAssertEqual(groups.map(\.title), ["site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["2"])
    }

    func testStatusGroupsComeOutInFixedOrder() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "failed"),
                item("2", cwd: inter, state: "running"),
                item("3", cwd: inter, state: "completed"),
                item("4", cwd: inter, state: "needs_input"),
                item("5", cwd: inter, state: "blocked"),
                item("6", cwd: inter, state: "queued"),
                item("7", cwd: inter, state: "answered"),
                item("8", cwd: inter, state: "cancelled"),
                item("9", cwd: inter, state: "garbage"),
            ],
            project: nil,
            grouping: .status
        )
        XCTAssertEqual(
            groups.map(\.title),
            ["Needs input", "Blocked", "Running", "Queued", "Answered", "Completed", "Failed", "Cancelled", "Unknown"],
            "status groups follow the fixed order, not first appearance"
        )
    }

    func testStatusGroupingSkipsAbsentStates() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "running"),
                item("2", cwd: inter, state: "completed"),
                item("3", cwd: inter, state: "completed"),
            ],
            project: nil,
            grouping: .status
        )
        XCTAssertEqual(groups.map(\.title), ["Running", "Completed"])
        XCTAssertEqual(
            groups.flatMap { $0.tasks }.count, 3,
            "a state nobody is in must not spend a heading on an empty group"
        )
    }

    func testStatusGroupingKeepsTheStoresOrderInsideEachGroup() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "completed"),
                item("2", cwd: inter, state: "running"),
                item("3", cwd: inter, state: "completed"),
                item("4", cwd: inter, state: "running"),
            ],
            project: nil,
            grouping: .status
        )
        XCTAssertEqual(groups[0].tasks.map(\.id), ["2", "4"], "newest-first order survives bucketing")
        XCTAssertEqual(groups[1].tasks.map(\.id), ["1", "3"])
    }

    func testStatusGroupingComposesWithTheProjectFilter() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "failed"),
                item("2", cwd: site, state: "failed"),
                item("3", cwd: inter, state: "running"),
            ],
            project: inter,
            grouping: .status
        )
        XCTAssertEqual(groups.map(\.title), ["Running", "Failed"], "filtering runs before grouping")
        XCTAssertEqual(groups.map { $0.tasks.map(\.id) }, [["3"], ["1"]])
    }

    func testStatusGroupIDIsTheRawState() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter, state: "needs_input")],
            project: nil,
            grouping: .status
        )
        XCTAssertEqual(
            groups.map(\.id), ["needs_input"],
            "the id comes from the state, so a collapse key survives refreshes"
        )
    }

    func testSiblingsShareTheirParentsGroup() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("root", cwd: inter, promptPreview: "Ship the landing page\nwith three sections"),
                item("a", cwd: inter, parent: "root"),
                item("b", cwd: inter, parent: "root"),
                item("solo", cwd: site),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].title, "Ship the landing page", "heading is the root prompt's first line")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["root", "a", "b"])
        XCTAssertNil(groups[1].title, "an unlinked lone task would otherwise print its prompt twice")
        XCTAssertEqual(groups[1].tasks.map(\.id), ["solo"])
    }

    func testGrandchildrenCollapseIntoTheRootGroup() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("root", cwd: inter, promptPreview: "Retry the failed build"),
                item("child", cwd: inter, parent: "root"),
                item("grandchild", cwd: inter, parent: "child"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups.count, 1, "a reply chain is one cluster, not one group per hop")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["root", "child", "grandchild"])
    }

    func testPurgedParentMakesTheChildItsOwnRoot() {
        let groups = TaskOrganizer.organize(
            tasks: [item("child", cwd: inter, parent: "evicted", promptPreview: "Keep going")],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(
            groups[0].title, "Keep going",
            "a child whose parent aged out still needs a heading of its own"
        )
    }

    func testParentCycleTerminates() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("a", cwd: inter, parent: "b", promptPreview: "First"),
                item("b", cwd: inter, parent: "a", promptPreview: "Second"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups.flatMap { $0.tasks }.count, 2, "corrupt parent data must not hang the sidebar")
    }

    func testLongHeadingIsTruncated() {
        let heading = TaskOrganizer.heading(String(repeating: "delegate ", count: 20))
        XCTAssertLessThanOrEqual(heading.count, 38)
        XCTAssertTrue(heading.hasSuffix("…"))
    }

    func testTitleWinsOverThePromptFirstLine() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("root", cwd: inter, promptPreview: "Build the marketing site\nwith a contact form", title: "Ship the landing page"),
                item("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups[0].title, "Ship the landing page", "the broker's label is the heading when a task has one")
    }

    func testMissingOrBlankTitleFallsBackToThePromptFirstLine() {
        let withTitle = TaskOrganizer.organize(
            tasks: [
                item("root", cwd: inter, promptPreview: "Retry the failed build", title: "   "),
                item("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(withTitle[0].title, "Retry the failed build")

        let untitled = TaskOrganizer.organize(
            tasks: [
                item("root", cwd: inter, promptPreview: "Retry the failed build"),
                item("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(untitled[0].title, "Retry the failed build")
    }

    func testDisplayLabelPrefersTheTitle() {
        let labeled = item("1", cwd: inter, promptPreview: "Build the marketing site\nwith a contact form", title: "Ship the landing page")
        XCTAssertEqual(labeled.displayLabel, "Ship the landing page", "the broker's label is the row's label when a task has one")
    }

    func testDisplayLabelFallsBackToThePromptFirstLine() {
        let blank = item("1", cwd: inter, promptPreview: "Retry the failed build", title: "   ")
        XCTAssertEqual(blank.displayLabel, "Retry the failed build", "a blank title falls back to the prompt's first line")

        let untitled = item("2", cwd: inter, promptPreview: "Retry the failed build")
        XCTAssertEqual(untitled.displayLabel, "Retry the failed build", "a missing title falls back to the prompt's first line")
    }

    func testCollapsingHidesOnlyTheGroupsRows() {
        let groups = TaskOrganizer.organize(
            tasks: [item("1", cwd: inter), item("2", cwd: site)],
            project: nil,
            grouping: .project
        )
        let collapsed: Set<String> = [inter]
        XCTAssertEqual(TaskOrganizer.visibleTasks(in: groups[0], collapsed: collapsed), [])
        XCTAssertEqual(TaskOrganizer.visibleTasks(in: groups[1], collapsed: collapsed).map(\.id), ["2"])
    }

    func testAnUntitledRunIgnoresAStaleCollapsedID() {
        let groups = TaskOrganizer.organize(
            tasks: [item("solo", cwd: inter)],
            project: nil,
            grouping: .parent
        )
        XCTAssertNil(groups[0].title)
        XCTAssertEqual(
            TaskOrganizer.visibleTasks(in: groups[0], collapsed: ["solo"]).map(\.id), ["solo"],
            "a run with no heading has no control to reopen it, so it must never hide"
        )
    }

    func testCollapsedGroupsSurviveEncodeDecodeRoundTrip() {
        var groups = CollapsedGroups()
        groups.toggle("root", mode: TaskGrouping.parent.rawValue)
        groups.toggle("completed", mode: TaskGrouping.status.rawValue)
        let restored = CollapsedGroups.decode(groups.encode(), legacyMode: TaskGrouping.none.rawValue)
        XCTAssertEqual(restored.ids(for: TaskGrouping.parent.rawValue), ["root"])
        XCTAssertEqual(restored.ids(for: TaskGrouping.status.rawValue), ["completed"])
        XCTAssertTrue(restored.ids(for: TaskGrouping.none.rawValue).isEmpty)
    }

    func testEncodeSortsKeysForAStableStoredString() {
        var groups = CollapsedGroups()
        groups.toggle("completed", mode: TaskGrouping.status.rawValue)
        groups.toggle("root", mode: TaskGrouping.parent.rawValue)
        XCTAssertEqual(
            groups.encode(), #"{"parent":["root"],"status":["completed"]}"#,
            "sorted keys keep the stored string stable and diffable across saves"
        )
    }

    func testLegacyNewlineDataLandsInTheGivenModeOnly() {
        let groups = CollapsedGroups.decode("root\naged-out", legacyMode: TaskGrouping.parent.rawValue)
        XCTAssertEqual(groups.ids(for: TaskGrouping.parent.rawValue), ["root", "aged-out"])
        XCTAssertEqual(
            groups.ids(for: TaskGrouping.status.rawValue), [],
            "legacy ids belong to the mode they were saved in, not every mode"
        )
    }

    func testToggleInOneModeLeavesTheOtherModesUntouched() {
        var groups = CollapsedGroups()
        groups.toggle("root", mode: TaskGrouping.parent.rawValue)
        groups.toggle("completed", mode: TaskGrouping.status.rawValue)
        groups.toggle("child", mode: TaskGrouping.parent.rawValue)
        XCTAssertEqual(groups.ids(for: TaskGrouping.parent.rawValue), ["root", "child"])
        XCTAssertEqual(groups.ids(for: TaskGrouping.status.rawValue), ["completed"])
    }

    func testTogglingTwiceEmptiesTheModeAndTheStore() {
        var groups = CollapsedGroups()
        groups.toggle("root", mode: TaskGrouping.parent.rawValue)
        groups.toggle("root", mode: TaskGrouping.parent.rawValue)
        XCTAssertTrue(groups.ids(for: TaskGrouping.parent.rawValue).isEmpty)
        XCTAssertEqual(groups.encode(), "", "a mode emptied by toggling must not linger as an empty key")
    }

    func testTheCapDropsTheOldestIDInAMode() {
        var groups = CollapsedGroups()
        for index in 0..<(CollapsedGroups.maxPerMode + 1) {
            groups.toggle(String(index), mode: TaskGrouping.parent.rawValue)
        }
        let ids = groups.ids(for: TaskGrouping.parent.rawValue)
        XCTAssertEqual(ids.count, CollapsedGroups.maxPerMode)
        XCTAssertFalse(ids.contains("0"), "the oldest id gives way when the cap is hit")
        XCTAssertTrue(ids.contains(String(CollapsedGroups.maxPerMode)))
    }

    func testMalformedAndEmptyInputDecodeEmpty() {
        XCTAssertEqual(CollapsedGroups.decode("", legacyMode: TaskGrouping.parent.rawValue).encode(), "")
        XCTAssertEqual(
            CollapsedGroups.decode(#"{"parent": 5}"#, legacyMode: TaskGrouping.parent.rawValue).encode(), "",
            "a JSON value that is not the id-object shape is junk, not legacy ids"
        )
    }

    func testProjectNameFallsBackToTheWholePathWhenUnsplittable() {
        XCTAssertEqual(TaskOrganizer.projectName("inter"), "inter")
        XCTAssertEqual(TaskOrganizer.projectName("/Users/dev/desgn/inter/"), "inter")
    }

    func testArchiveSelectionMovesToTheNextTask() {
        XCTAssertEqual(
            TaskOrganizer.neighbor(afterRemoving: "second", from: ["first", "second", "third"]),
            "third"
        )
    }

    func testArchiveSelectionFallsBackToThePreviousTask() {
        XCTAssertEqual(TaskOrganizer.neighbor(afterRemoving: "third", from: ["first", "second", "third"]), "second")
        XCTAssertNil(TaskOrganizer.neighbor(afterRemoving: "only", from: ["only"]))
    }

    func testPrioritySortOrdersAttentionFirst() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "completed"),
                item("2", cwd: inter, state: "running"),
                item("3", cwd: inter, state: "failed"),
                item("4", cwd: inter, state: "needs_input"),
                item("5", cwd: inter, state: "blocked"),
            ],
            project: nil,
            grouping: .none,
            sort: .priority
        )
        XCTAssertEqual(
            groups[0].tasks.map(\.id), ["4", "5", "3", "2", "1"],
            "attention first, then live work, then the settled ledger"
        )
    }

    func testPrioritySortTiesKeepTheStoresOrder() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "completed"),
                item("2", cwd: inter, state: "failed"),
                item("3", cwd: inter, state: "completed"),
            ],
            project: nil,
            grouping: .none,
            sort: .priority
        )
        XCTAssertEqual(groups[0].tasks.map(\.id), ["2", "1", "3"], "equal ranks fall back to the store's order")
    }

    func testUpdatedSortOrdersNewestUpdateFirst() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("old", cwd: inter, updatedAt: "2026-07-29T08:00:00Z"),
                item("new", cwd: inter, updatedAt: "2026-07-30T09:15:00.000Z"),
                item("mid", cwd: inter, updatedAt: "2026-07-29T22:00:00Z"),
            ],
            project: nil,
            grouping: .none,
            sort: .updated
        )
        XCTAssertEqual(
            groups[0].tasks.map(\.id), ["new", "mid", "old"],
            "most recently updated first, whether or not the timestamp carries milliseconds"
        )
    }

    func testUpdatedSortTiesKeepTheStoresOrder() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, updatedAt: "2026-07-29T10:00:00Z"),
                item("2", cwd: inter, updatedAt: "2026-07-29T10:00:00.000Z"),
                item("3", cwd: inter, updatedAt: "2026-07-29T10:00:00Z"),
            ],
            project: nil,
            grouping: .none,
            sort: .updated
        )
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "2", "3"], "equal update times fall back to the store's order")
    }

    func testUpdatedSortComposesWithGrouping() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, updatedAt: "2026-07-29T08:00:00Z"),
                item("2", cwd: site, updatedAt: "2026-07-30T09:00:00Z"),
                item("3", cwd: inter, updatedAt: "2026-07-30T10:00:00Z"),
                item("4", cwd: site, updatedAt: "2026-07-29T11:00:00Z"),
            ],
            project: nil,
            grouping: .project,
            sort: .updated
        )
        XCTAssertEqual(groups.map(\.title), ["inter", "site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["3", "1"], "newest update first inside the project group")
        XCTAssertEqual(groups[1].tasks.map(\.id), ["2", "4"])
    }

    func testGroupingComposesWithPrioritySort() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "completed"),
                item("2", cwd: site, state: "running"),
                item("3", cwd: inter, state: "needs_input"),
                item("4", cwd: site, state: "failed"),
            ],
            project: nil,
            grouping: .project,
            sort: .priority
        )
        XCTAssertEqual(groups.map(\.title), ["inter", "site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["3", "1"], "priority orders the rows inside the project group")
        XCTAssertEqual(groups[1].tasks.map(\.id), ["4", "2"])
    }

    func testArchiveFilterRawValuesMatchTheBrokersVocabulary() {
        XCTAssertEqual(TaskArchiveFilter.active.rawValue, "active")
        XCTAssertEqual(TaskArchiveFilter.archived.rawValue, "only")
        XCTAssertEqual(TaskArchiveFilter.all.rawValue, "include")
    }

    func testArchiveFilterLabelsCoverEveryCase() {
        XCTAssertEqual(TaskArchiveFilter.allCases.map(\.label), ["Active", "Archived", "All"])
    }

    func testDefaultSortKeepsTheStoresOrder() {
        let groups = TaskOrganizer.organize(
            tasks: [
                item("1", cwd: inter, state: "needs_input"),
                item("2", cwd: inter, state: "completed"),
                item("3", cwd: inter, state: "failed"),
            ],
            project: nil,
            grouping: .none
        )
        XCTAssertEqual(
            groups[0].tasks.map(\.id), ["1", "2", "3"],
            "the sort defaults to the list's recent-first order, not priority"
        )
    }
}
