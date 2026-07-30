import XCTest

@testable import Inter

final class TaskGroupingTests: XCTestCase {
    private func task(_ id: String, cwd: String) -> TaskSnapshot {
        TaskSnapshot(
            id: id,
            profileId: "worker",
            model: "sonnet",
            prompt: "prompt",
            cwd: cwd,
            state: "completed",
            createdAt: "2026-07-29T10:00:00Z",
            updatedAt: "2026-07-29T10:00:00Z",
            output: "",
            error: nil,
            question: nil,
            parentTaskId: nil
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
            grouped: false
        )
        XCTAssertEqual(groups.count, 1)
        XCTAssertNil(groups[0].title, "an ungrouped list carries no heading")
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"])
    }

    func testStaleFilterFallsBackToEveryTask() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter)],
            project: "/Users/malico/deleted-checkout",
            grouped: false
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
            grouped: true
        )
        XCTAssertEqual(groups.map(\.title), ["inter", "site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["1", "3"])
        XCTAssertEqual(groups[1].tasks.map(\.id), ["2"])
    }

    func testFilterAndGroupingCombine() {
        let groups = TaskOrganizer.organize(
            tasks: [task("1", cwd: inter), task("2", cwd: site)],
            project: site,
            grouped: true
        )
        XCTAssertEqual(groups.map(\.title), ["site"])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["2"])
    }

    func testProjectNameFallsBackToTheWholePathWhenUnsplittable() {
        XCTAssertEqual(TaskOrganizer.projectName("inter"), "inter")
        XCTAssertEqual(TaskOrganizer.projectName("/Users/malico/desgn/inter/"), "inter")
    }
}
