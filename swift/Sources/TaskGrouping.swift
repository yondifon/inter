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
        case .none: "None"
        }
    }
}

/// How the rows within a group are ordered.
enum TaskSort: String, CaseIterable, Identifiable {
    case recent
    case priority

    var id: Self { self }

    var label: String {
        switch self {
        case .recent: "Newest first"
        case .priority: "Priority"
        }
    }
}

/// One rendered run of task rows. `title` is nil for a run that needs no heading.
struct TaskGroup: Identifiable {
    let id: String
    let title: String?
    let tasks: [TaskListItem]
    /// Untruncated form of `title`, for the header tooltip. A heading clipped
    /// at the sidebar limit would otherwise lose the rest of the sentence.
    var fullTitle: String? = nil
}

/// Collapse state for the sidebar's task groups, kept per grouping mode because
/// the modes do not share an id space — parent mode keys a group by a task id,
/// status by a state name, project by a folder path. A flat set of ids was only
/// ever coherent inside one mode, and pruning it against the rows currently on
/// screen erased whatever the active filter hid. Stale ids are cheap:
/// `visibleTasks` already ignores a collapsed id whose group has no heading,
/// which is what buys the size cap in place of pruning.
struct CollapsedGroups: Equatable {
    /// The most ids one mode can hold. Deep enough for a day of runs, and a hard
    /// stop on unbounded growth.
    static let maxPerMode = 200

    private var byMode: [String: [String]] = [:]

    /// Reads the new per-mode JSON object. A non-empty value that is not that
    /// shape is a save from before the format change, so it lands whole in
    /// `legacyMode`; JSON of any other shape is junk, and junk decodes empty.
    static func decode(_ raw: String, legacyMode: String) -> CollapsedGroups {
        var groups = CollapsedGroups()
        guard !raw.isEmpty else { return groups }
        if let decoded = try? JSONDecoder().decode([String: [String]].self, from: Data(raw.utf8)) {
            for (mode, ids) in decoded where !ids.isEmpty {
                groups.byMode[mode] = ids
            }
            return groups
        }
        if let first = raw.first(where: { !$0.isWhitespace }),
           first == "{" || first == "[" {
            return groups
        }
        groups.byMode[legacyMode] = raw.split(separator: "\n").map(String.init)
        return groups
    }

    /// Keys sorted so the stored string is stable across saves. Empty stays
    /// empty — an empty object would be a new format the decoder reads as junk.
    func encode() -> String {
        guard !byMode.isEmpty else { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(byMode),
              let json = String(data: data, encoding: .utf8) else { return "" }
        return json
    }

    func ids(for mode: String) -> Set<String> {
        Set(byMode[mode] ?? [])
    }

    mutating func toggle(_ id: String, mode: String) {
        var ids = byMode[mode] ?? []
        if let index = ids.firstIndex(of: id) {
            ids.remove(at: index)
        } else {
            ids.append(id)
            if ids.count > Self.maxPerMode {
                ids.removeFirst(ids.count - Self.maxPerMode)
            }
        }
        if ids.isEmpty {
            byMode.removeValue(forKey: mode)
        } else {
            byMode[mode] = ids
        }
    }
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
    static func projects(in tasks: [TaskListItem]) -> [TaskProject] {
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
        tasks: [TaskListItem],
        project: String?,
        grouping: TaskGrouping,
        sort: TaskSort = .recent
    ) -> [TaskGroup] {
        let known = Set(tasks.map(\.cwd))
        let active = project.flatMap { known.contains($0) ? $0 : nil }
        let scoped = active.map { path in tasks.filter { $0.cwd == path } } ?? tasks

        switch grouping {
        case .none:
            return [TaskGroup(id: "all", title: nil, tasks: sorted(scoped, by: sort))]
        case .project:
            return sortedGroups(bucket(scoped) { ($0.cwd, projectName($0.cwd)) }, by: sort)
        case .parent:
            return sortedGroups(parentGroups(scoped), by: sort)
        case .status:
            return sortedGroups(statusGroups(scoped, orderedBy: statusOrder), by: sort)
        }
    }

    /// Name to show for an active filter, or nil when every project is showing.
    static func activeProjectName(tasks: [TaskListItem], project: String?) -> String? {
        guard let project, tasks.contains(where: { $0.cwd == project }) else { return nil }
        return projectName(project)
    }

    /// Groups every task under the root of its parent chain. A task that is nobody's
    /// child and nobody's parent gets no heading — a lone run titled with its own
    /// prompt would print the same sentence twice.
    private static func parentGroups(_ tasks: [TaskListItem]) -> [TaskGroup] {
        let byID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let groups = bucket(tasks) { task in
            let root = self.root(of: task, in: byID)
            return (root.id, heading(for: root))
        }
        return groups.map { group in
            let solo = group.tasks.count == 1 && group.tasks[0].parentTaskId == nil
            if solo { return TaskGroup(id: group.id, title: nil, tasks: group.tasks) }
            let root = self.root(of: group.tasks[0], in: byID)
            return TaskGroup(id: group.id, title: group.title, tasks: group.tasks, fullTitle: Self.fullHeading(for: root))
        }
    }

    /// Walks to the topmost ancestor present in the list. A parent that was purged,
    /// or a cycle, resolves to the deepest task actually reachable.
    private static func root(
        of task: TaskListItem,
        in byID: [String: TaskListItem]
    ) -> TaskListItem {
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
        _ tasks: [TaskListItem],
        by key: (TaskListItem) -> (id: String, title: String)
    ) -> [TaskGroup] {
        var order: [String] = []
        var titles: [String: String] = [:]
        var buckets: [String: [TaskListItem]] = [:]
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

    /// Attention first: a task waiting on the user, one blocked, then a run that
    /// ended without deciding, then live and queued work, and the settled ledger
    /// closes the list. Unknown goes last like every other order.
    private static let priorityOrder: [TaskState] = [
        .needsInput, .blocked, .failed,
        .running, .answered, .queued,
        .completed, .cancelled,
        .unknown,
    ]

    /// Buckets by state in the given order, so a state nobody is in right now
    /// costs no heading and the rows keep the store's newest-first order.
    private static func statusGroups(_ tasks: [TaskListItem], orderedBy order: [TaskState]) -> [TaskGroup] {
        var buckets: [TaskState: [TaskListItem]] = [:]
        for task in tasks {
            buckets[TaskState(task.state), default: []].append(task)
        }
        return order.compactMap { state in
            guard let rows = buckets[state], !rows.isEmpty else { return nil }
            return TaskGroup(id: state.rawValue, title: state.label, tasks: rows)
        }
    }

    /// Orders the rows of one group. `.recent` keeps the store's newest-first
    /// order; `.priority` ranks by attention state, ties keeping the store order.
    private static func sorted(_ tasks: [TaskListItem], by sort: TaskSort) -> [TaskListItem] {
        switch sort {
        case .recent:
            return tasks
        case .priority:
            return tasks.enumerated()
                .sorted { lhs, rhs in
                    let l = priorityRank(lhs.element)
                    let r = priorityRank(rhs.element)
                    if l != r { return l < r }
                    return lhs.offset < rhs.offset
                }
                .map(\.element)
        }
    }

    private static func priorityRank(_ task: TaskListItem) -> Int {
        priorityOrder.firstIndex(of: TaskState(task.state)) ?? priorityOrder.count
    }

    /// Rebuilds each group with its rows sorted, carrying the full heading over.
    private static func sortedGroups(_ groups: [TaskGroup], by sort: TaskSort) -> [TaskGroup] {
        groups.map { group in
            TaskGroup(id: group.id, title: group.title, tasks: sorted(group.tasks, by: sort), fullTitle: group.fullTitle)
        }
    }

    /// Rows to draw for a group. Only a group with a heading can be collapsed —
    /// an untitled run has no control to expand it again, so a stale collapsed id
    /// left over from when it had children must not hide it.
    static func visibleTasks(in group: TaskGroup, collapsed: Set<String>) -> [TaskListItem] {
        guard group.title != nil, collapsed.contains(group.id) else { return group.tasks }
        return []
    }

    /// First line of a label, trimmed — the heading before the length cap.
    private static func headingText(_ label: String) -> String {
        label.components(separatedBy: .newlines).first?.trimmingCharacters(in: .whitespaces) ?? label
    }

    /// First line of a prompt, short enough for a 260pt sidebar heading.
    static func heading(_ prompt: String) -> String {
        let line = headingText(prompt)
        guard line.count > headingLimit else { return line }
        return "\(line.prefix(headingLimit - 1))…"
    }

    /// Heading for a group rooted at this task: the broker's short label when
    /// it has one, otherwise the prompt's first line.
    static func heading(for task: TaskListItem) -> String {
        heading(task.displayLabel)
    }

    /// The heading without the length cap, for the header's tooltip.
    static func fullHeading(for task: TaskListItem) -> String {
        headingText(task.displayLabel)
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
