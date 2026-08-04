import XCTest

@testable import Inter

final class TaskGroupingTests: XCTestCase {
    private func task(_ id: String, cwd: String, parent: String? = nil, prompt: String = "prompt", title: String? = nil, state: String = "completed") -> TaskSnapshot {
        TaskSnapshot(
            id: id,
            profileId: "worker",
            model: "sonnet",
            prompt: prompt,
            title: title,
            cwd: cwd,
            state: state,
            createdAt: "2026-07-29T10:00:00Z",
            updatedAt: "2026-07-29T10:00:00Z",
            output: "",
            error: nil,
            question: nil,
            parentTaskId: parent
        )
    }

    private let inter = "/Users/malico/desgn/inter"
    private let site = "/Users/malico/work/site"

    func testProjectsCountTasksInFirstSeenOrder() {
        let projects = TaskOrganizer.projects(in: [
            task("1", cwd: inter),
            task("2", cwd: site),
            task("3", cwd: inter),
        ])
        XCTAssertEqual(projects.map(\.name), ["inter", "site"])
        XCTAssertEqual(projects.map(\.count), [2, 1])
        XCTAssertEqual(projects.first?.id, inter, "the full path is the identity, not the folder name")
    }

    func testFilterKeepsOnlyTheSelectedProject() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter), task("2", cwd: site), task("3", cwd: inter)],
            project: inter,
            grouping: .project
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].title, "inter")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"])
    }

    func testGroupingNothingReturnsOneUntitledRun() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter), task("2", cwd: site)],
            project: nil,
            grouping: .none
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertNil(groups[0].title, "an ungrouped list carries no heading")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "2"])
    }

    func testStaleFilterFallsBackToEveryTask() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter)],
            project: "/Users/malico/deleted-checkout",
            grouping: .none
        )
        XCTAssertEqual(
            groups[0].tasks.map(\.id), ["1"],
            "a saved filter for a project with no tasks must not strand the sidebar empty"
        )
        XCTAssertNil(TaskOrganizer.activeProjectName(tasks: [task("1", cwd: inter)], project: "/gone"))
    }

    func testGroupingPreservesTaskOrderWithinEachProject() {
        let groups = TaskOrganizer.organize(
            tasks: [
                task("1", cwd: inter),
                task("2", cwd: site),
                task("3", cwd: inter),
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
            tasks: [task("1", cwd: inter), task("2", cwd: site)],
            project: site,
            grouping: .project
        )
        XCTAssertEqual(groups.map(\.title), ["site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["2"])
    }

    func testStatusGroupsComeOutInFixedOrder() {
        let groups = TaskOrganizer.organize(
            tasks: [
                task("1", cwd: inter, state: "failed"),
                task("2", cwd: inter, state: "running"),
                task("3", cwd: inter, state: "completed"),
                task("4", cwd: inter, state: "needs_input"),
                task("5", cwd: inter, state: "blocked"),
                task("6", cwd: inter, state: "queued"),
                task("7", cwd: inter, state: "answered"),
                task("8", cwd: inter, state: "cancelled"),
                task("9", cwd: inter, state: "garbage"),
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
                task("1", cwd: inter, state: "running"),
                task("2", cwd: inter, state: "completed"),
                task("3", cwd: inter, state: "completed"),
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
                task("1", cwd: inter, state: "completed"),
                task("2", cwd: inter, state: "running"),
                task("3", cwd: inter, state: "completed"),
                task("4", cwd: inter, state: "running"),
            ],
            project: nil,
            grouping: .status
        )
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"], "newest-first order survives bucketing")
        XCTAssertEqual(groups[1].tasks.map(\.id), ["2", "4"])
    }

    func testStatusGroupingComposesWithTheProjectFilter() {
        let groups = TaskOrganizer.organize(
            tasks: [
                task("1", cwd: inter, state: "failed"),
                task("2", cwd: site, state: "failed"),
                task("3", cwd: inter, state: "running"),
            ],
            project: inter,
            grouping: .status
        )
        XCTAssertEqual(groups.map(\.title), ["Running", "Failed"], "filtering runs before grouping")
        XCTAssertEqual(groups.map { $0.tasks.map(\.id) }, [["3"], ["1"]])
    }

    func testStatusGroupIDIsTheRawState() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter, state: "needs_input")],
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
                task("root", cwd: inter, prompt: "Ship the landing page\nwith three sections"),
                task("a", cwd: inter, parent: "root"),
                task("b", cwd: inter, parent: "root"),
                task("solo", cwd: site),
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
                task("root", cwd: inter, prompt: "Retry the failed build"),
                task("child", cwd: inter, parent: "root"),
                task("grandchild", cwd: inter, parent: "child"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups.count, 1, "a reply chain is one cluster, not one group per hop")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["root", "child", "grandchild"])
    }

    func testPurgedParentMakesTheChildItsOwnRoot() {
        let groups = TaskOrganizer.organize(
            tasks: [task("child", cwd: inter, parent: "evicted", prompt: "Keep going")],
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
                task("a", cwd: inter, parent: "b", prompt: "First"),
                task("b", cwd: inter, parent: "a", prompt: "Second"),
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
                task("root", cwd: inter, prompt: "Build the marketing site\nwith a contact form", title: "Ship the landing page"),
                task("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(groups[0].title, "Ship the landing page", "the broker's label is the heading when a task has one")
    }

    func testMissingOrBlankTitleFallsBackToThePromptFirstLine() {
        let withTitle = TaskOrganizer.organize(
            tasks: [
                task("root", cwd: inter, prompt: "Retry the failed build", title: "   "),
                task("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(withTitle[0].title, "Retry the failed build")

        let untitled = TaskOrganizer.organize(
            tasks: [
                task("root", cwd: inter, prompt: "Retry the failed build"),
                task("a", cwd: inter, parent: "root"),
            ],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(untitled[0].title, "Retry the failed build")
    }

    func testDisplayLabelPrefersTheTitle() {
        let labeled = task("1", cwd: inter, prompt: "Build the marketing site\nwith a contact form", title: "Ship the landing page")
        XCTAssertEqual(labeled.displayLabel, "Ship the landing page", "the broker's label is the row's label when a task has one")
    }

    func testDisplayLabelFallsBackToThePromptFirstLine() {
        let blank = task("1", cwd: inter, prompt: "Retry the failed build", title: "   ")
        XCTAssertEqual(blank.displayLabel, "Retry the failed build", "a blank title falls back to the prompt's first line")

        let untitled = task("2", cwd: inter, prompt: "Retry the failed build")
        XCTAssertEqual(untitled.displayLabel, "Retry the failed build", "a missing title falls back to the prompt's first line")
    }

    func testCollapsingHidesOnlyTheGroupsRows() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter), task("2", cwd: site)],
            project: nil,
            grouping: .project
        )
        let collapsed: Set<String> = [inter]
        XCTAssertEqual(TaskOrganizer.visibleTasks(in: groups[0], collapsed: collapsed), [])
        XCTAssertEqual(TaskOrganizer.visibleTasks(in: groups[1], collapsed: collapsed).map(\.id), ["2"])
    }

    func testAnUntitledRunIgnoresAStaleCollapsedID() {
        let groups = TaskOrganizer.organize(
            tasks: [task("solo", cwd: inter)],
            project: nil,
            grouping: .parent
        )
        XCTAssertNil(groups[0].title)
        XCTAssertEqual(
            TaskOrganizer.visibleTasks(in: groups[0], collapsed: ["solo"]).map(\.id), ["solo"],
            "a run with no heading has no control to reopen it, so it must never hide"
        )
    }

    func testPruningDropsIDsForGroupsThatAreGone() {
        let groups = TaskOrganizer.organize(
            tasks: [task("root", cwd: inter), task("child", cwd: inter, parent: "root")],
            project: nil,
            grouping: .parent
        )
        XCTAssertEqual(
            TaskOrganizer.pruneCollapsed(["root", "aged-out", inter], groups: groups), ["root"],
            "saved collapse state must not accumulate ids for tasks that left the list"
        )
    }

    func testProjectNameFallsBackToTheWholePathWhenUnsplittable() {
        XCTAssertEqual(TaskOrganizer.projectName("inter"), "inter")
        XCTAssertEqual(TaskOrganizer.projectName("/Users/malico/desgn/inter/"), "inter")
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
}
