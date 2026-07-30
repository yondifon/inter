import Foundation

/// A folder tasks were delegated in. The full path is the identity because two
/// checkouts can share a folder name.
struct TaskProject: Identifiable, Hashable {
    let id: String
    let name: String
    let count: Int
}

/// One rendered run of task rows. `title` is nil for the ungrouped list.
struct TaskGroup: Identifiable {
    let id: String
    let title: String?
    let tasks: [TaskSnapshot]
}

/// Filtering and grouping for the task list. Pure, so the ordering rules that
/// matter — newest project first, newest task first — are testable without a view.
enum TaskOrganizer {
    static func projectName(_ path: String) -> String {
        path.split(separator: "/").map(String.init).last ?? path
    }

    /// Projects in the order their newest task appears, so an active project stays
    /// at the top of the menu.
    static func projects(in tasks: [TaskSnapshot]) -> [TaskProject] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for task in tasks {
            if counts[task.cwd] == nil { order.append(task.cwd) }
            counts[task.cwd, default: 0] += 1
        }
        return order.map { TaskProject(id: $0, name: projectName($0), count: counts[$0] ?? 0) }
    }

    /// A saved filter naming a project with no tasks left is ignored rather than
    /// honored, so a stale preference can never strand the sidebar on an empty list.
    static func organize(tasks: [TaskSnapshot], project: String?, grouped: Bool) -> [TaskGroup] {
        let known = Set(tasks.map(\.cwd))
        let active = project.flatMap { known.contains($0) ? $0 : nil }
        let scoped = active.map { path in tasks.filter { $0.cwd == path } } ?? tasks

        guard grouped else { return [TaskGroup(id: "all", title: nil, tasks: scoped)] }

        var order: [String] = []
        var buckets: [String: [TaskSnapshot]] = [:]
        for task in scoped {
            if buckets[task.cwd] == nil { order.append(task.cwd) }
            buckets[task.cwd, default: []].append(task)
        }
        return order.map { TaskGroup(id: $0, title: projectName($0), tasks: buckets[$0] ?? []) }
    }

    /// Name to show for an active filter, or nil when every project is showing.
    static func activeProjectName(tasks: [TaskSnapshot], project: String?) -> String? {
        guard let project, tasks.contains(where: { $0.cwd == project }) else { return nil }
        return projectName(project)
    }
}
