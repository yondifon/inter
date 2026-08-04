import Foundation

/// A folder tasks were delegated in. The full path is the identity because two
/// checkouts can share a folder name.
struct TaskProject: Identifiable, Hashable {
    let id: String
    let name: String
    let count: Int
}

/// How the task list is divided.
enum TaskGrouping: String, CaseIterable, Identifiable {
    case parent
    case project
    case status
    case none

    var id: Self { self }

    var label: String {
        switch self {
        case .parent: "Parent task"
        case .project: "Project"
        case .status: "Status"
        case .none: "Nothing"
        }
    }
}

/// One rendered run of task rows. `title` is nil for a run that needs no heading.
struct TaskGroup: Identifiable {
    let id: String
    let title: String?
    let tasks: [TaskSnapshot]
}

/// Filtering and grouping for the task list. Pure, so the ordering and
/// parent-walking rules are testable without a view.
enum TaskOrganizer {
    /// Deep enough for any real delegation tree, and a hard stop if task data ever
    /// contains a parent cycle.
    private static let maxParentDepth = 32
    private static let headingLimit = 38

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
    static func organize(
        tasks: [TaskSnapshot],
        project: String?,
        grouping: TaskGrouping
    ) -> [TaskGroup] {
        let known = Set(tasks.map(\.cwd))
        let active = project.flatMap { known.contains($0) ? $0 : nil }
        let scoped = active.map { path in tasks.filter { $0.cwd == path } } ?? tasks

        switch grouping {
        case .none:
            return [TaskGroup(id: "all", title: nil, tasks: scoped)]
        case .project:
            return bucket(scoped) { ($0.cwd, projectName($0.cwd)) }
        case .parent:
            return parentGroups(scoped)
        case .status:
            return statusGroups(scoped)
        }
    }

    /// Name to show for an active filter, or nil when every project is showing.
    static func activeProjectName(tasks: [TaskSnapshot], project: String?) -> String? {
        guard let project, tasks.contains(where: { $0.cwd == project }) else { return nil }
        return projectName(project)
    }

    /// Groups every task under the root of its parent chain. A task that is nobody's
    /// child and nobody's parent gets no heading — a lone run titled with its own
    /// prompt would print the same sentence twice.
    private static func parentGroups(_ tasks: [TaskSnapshot]) -> [TaskGroup] {
        let byID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let groups = bucket(tasks) { task in
            let root = self.root(of: task, in: byID)
            return (root.id, heading(for: root))
        }
        return groups.map { group in
            let solo = group.tasks.count == 1 && group.tasks[0].parentTaskId == nil
            return solo ? TaskGroup(id: group.id, title: nil, tasks: group.tasks) : group
        }
    }

    /// Walks to the topmost ancestor present in the list. A parent that was purged,
    /// or a cycle, resolves to the deepest task actually reachable.
    private static func root(
        of task: TaskSnapshot,
        in byID: [String: TaskSnapshot]
    ) -> TaskSnapshot {
        var current = task
        var seen: Set<String> = [task.id]
        for _ in 0..<maxParentDepth {
            guard let parentID = current.parentTaskId,
                  let parent = byID[parentID],
                  !seen.contains(parentID) else { return current }
            seen.insert(parentID)
            current = parent
        }
        return current
    }

    /// Buckets tasks by a key, keeping both the group order and the order within
    /// each group as the store sent them — newest first.
    private static func bucket(
        _ tasks: [TaskSnapshot],
        by key: (TaskSnapshot) -> (id: String, title: String)
    ) -> [TaskGroup] {
        var order: [String] = []
        var titles: [String: String] = [:]
        var buckets: [String: [TaskSnapshot]] = [:]
        for task in tasks {
            let (id, title) = key(task)
            if buckets[id] == nil {
                order.append(id)
                titles[id] = title
            }
            buckets[id, default: []].append(task)
        }
        return order.map { TaskGroup(id: $0, title: titles[$0], tasks: buckets[$0] ?? []) }
    }

    /// Wants a person first, live work next, the settled ledger after, unknown last.
    private static let statusOrder: [TaskState] = [
        .needsInput, .blocked,
        .running, .queued, .answered,
        .completed, .failed, .cancelled,
        .unknown,
    ]

    /// Buckets by state in the fixed order above, so a state nobody has right now
    /// costs no heading and the rows keep the store's newest-first order.
    private static func statusGroups(_ tasks: [TaskSnapshot]) -> [TaskGroup] {
        var buckets: [TaskState: [TaskSnapshot]] = [:]
        for task in tasks {
            buckets[TaskState(task.state), default: []].append(task)
        }
        return statusOrder.compactMap { state in
            guard let rows = buckets[state], !rows.isEmpty else { return nil }
            return TaskGroup(id: state.rawValue, title: state.label, tasks: rows)
        }
    }

    /// Rows to draw for a group. Only a group with a heading can be collapsed —
    /// an untitled run has no control to expand it again, so a stale collapsed id
    /// left over from when it had children must not hide it.
    static func visibleTasks(in group: TaskGroup, collapsed: Set<String>) -> [TaskSnapshot] {
        guard group.title != nil, collapsed.contains(group.id) else { return group.tasks }
        return []
    }

    /// Drops ids whose group is gone, so parent-task ids cannot pile up in the
    /// saved preference as tasks age out of the list.
    static func pruneCollapsed(_ collapsed: Set<String>, groups: [TaskGroup]) -> Set<String> {
        collapsed.intersection(Set(groups.filter { $0.title != nil }.map(\.id)))
    }

    /// First line of a prompt, short enough for a 260pt sidebar heading.
    static func heading(_ prompt: String) -> String {
        let line = prompt.components(separatedBy: .newlines).first?
            .trimmingCharacters(in: .whitespaces) ?? prompt
        guard line.count > headingLimit else { return line }
        return "\(line.prefix(headingLimit - 1))…"
    }

    /// Heading for a group rooted at this task: the broker's short label when
    /// it has one, otherwise the prompt's first line.
    static func heading(for task: TaskSnapshot) -> String {
        heading(task.displayLabel)
    }

    /// Keeps keyboard and reading flow after a row leaves the sidebar. Prefer the
    /// row below; when the last row is removed, fall back to the one above it.
    static func neighbor(afterRemoving id: String, from ids: [String]) -> String? {
        guard let index = ids.firstIndex(of: id) else { return ids.first }
        if index + 1 < ids.count { return ids[index + 1] }
        if index > 0 { return ids[index - 1] }
        return nil
    }
}
