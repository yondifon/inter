import SwiftUI

private enum SidebarSelection: Hashable {
    case task(String)
    /// Identified by cwd, which is what a project's memories are keyed to.
    case project(String)
}

struct ContentView: View {
    let store: ProfileStore
    let broker: BrokerManager
    let openSettings: () -> Void
    @State private var selection: SidebarSelection?
    @State private var installResults: [MCPConfigInjector.InstallResult] = []
    @State private var showingInstall = false
    @AppStorage("taskProjectFilter") private var projectFilter = ""
    @AppStorage("taskGrouping") private var groupingRaw = TaskGrouping.parent.rawValue
    @AppStorage("collapsedTaskGroups") private var collapsedRaw = ""
    @AppStorage("showArchivedTasks") private var showArchivedTasks = false
    @State private var taskPendingCancel: String?
    @State private var showingTaskActionError = false
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    if visibleTasks.isEmpty {
                        Text(showArchivedTasks ? "No archived tasks" : "No tasks yet")
                            .scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(taskGroups) { group in
                            if let title = group.title {
                                TaskGroupHeader(
                                    title: title,
                                    count: group.tasks.count,
                                    collapsed: collapsedGroups.contains(group.id)
                                ) { toggleCollapse(group.id) }
                                    .padding(.top, 8)
                                    .help(group.id)
                            }
                            ForEach(TaskOrganizer.visibleTasks(in: group, collapsed: collapsedGroups)) { task in
                                TaskRow(
                                    task: task,
                                    worker: store.profiles.first { $0.id == task.profileId }?.label ?? task.profileId
                                )
                                .tag(SidebarSelection.task(task.id))
                                .contextMenu {
                                    if canCancel(task) {
                                        Button("Cancel Task", systemImage: "xmark.circle", role: .destructive) {
                                            taskPendingCancel = task.id
                                        }
                                    }
                                    if canResume(task) {
                                        Button("Resume", systemImage: "arrow.clockwise.circle") {
                                            Task { await performResume(task.id) }
                                        }
                                    }
                                    Button(showArchivedTasks ? "Restore" : "Archive",
                                           systemImage: showArchivedTasks ? "arrow.uturn.backward" : "archivebox") {
                                        setArchived(task.id, !showArchivedTasks)
                                    }
                                }
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        SidebarSectionLabel(text: activeProjectName ?? (showArchivedTasks ? "Archived tasks" : "Recent tasks"))
                        Spacer(minLength: 0)
                        if !store.tasks.isEmpty { projectMenu }
                    }
                    .padding(.top, 10)
                    .padding(.bottom, 2)
                }
                Section {
                    if store.memoryProjects.isEmpty {
                        Text("No project memories yet")
                            .scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(store.memoryProjects) { project in
                            ProjectRow(project: project).tag(SidebarSelection.project(project.cwd))
                        }
                    }
                } header: {
                    SidebarSectionLabel(text: "Projects")
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                }
            }
            .listStyle(.sidebar)
            .scrollIndicators(.never)
            .safeAreaInset(edge: .bottom) { brokerIndicator }
            // The system sidebar material is translucent and cooler than the content
            // column. A flat neutral fill, run under the titlebar so no seam shows at
            // the toolbar, keeps the whole column one plane.
            .scrollContentBackground(.hidden)
            .background { Surface.sidebar.ignoresSafeArea() }
            .navigationSplitViewColumnWidth(min: 240, ideal: 260)
            // Graphite-style selection. The system accent turns a scanned list into
            // a blue slab; a neutral fill keeps the type as the loudest thing.
            .tint(Color(nsColor: .quaternaryLabelColor))
            .toolbar {
                ToolbarItem {
                    Button("Install MCP", systemImage: "link.badge.plus") {
                        installResults = MCPConfigInjector.installEverywhere(profiles: store.profiles)
                        showingInstall = true
                    }
                    .labelStyle(.iconOnly)
                    .help("Add Inter to every CLI's global MCP config")
                }
                ToolbarItem {
                    Button("Settings…", systemImage: "gearshape", action: openSettings)
                        .labelStyle(.iconOnly)
                        .help("Settings")
                }
            }
        } detail: {
            if case let .task(id) = selection,
               let item = store.tasks.first(where: { $0.id == id }) {
                TaskDetail(taskId: id, listItem: item, store: store, setArchived: setArchived)
                    .id(id)
            } else if case let .project(cwd) = selection,
                      let project = store.memoryProjects.first(where: { $0.cwd == cwd }) {
                ProjectMemoryView(project: project, store: store)
                    .id(project.cwd)
            } else {
                ContentUnavailableView("Choose a task or project", systemImage: "point.3.connected.trianglepath.dotted")
            }
        }
        .sheet(isPresented: $showingInstall) { InstallResultsView(results: installResults) }
        .task { store.start() }
        // Cancel from the context menu always confirms first (EC-004).
        .confirmationDialog(
            "Cancel this task?",
            isPresented: Binding(
                get: { taskPendingCancel != nil },
                set: { if !$0 { taskPendingCancel = nil } }
            ),
            titleVisibility: .visible,
            presenting: taskPendingCancel
        ) { id in
            Button("Cancel Task", role: .destructive) {
                Task { await performCancel(id) }
            }
            Button("Keep Running", role: .cancel) {}
        } message: { _ in
            Text("This stops the worker’s process tree. The task can be resumed later.")
        }
        .alert("Couldn’t update the task.", isPresented: $showingTaskActionError) {
            Button("OK", role: .cancel) {}
        }
        .frame(minWidth: 760, minHeight: 520)
    }

    private var visibleTasks: [TaskListItem] {
        store.tasks.filter { showArchivedTasks ? $0.archivedAt != nil : $0.archivedAt == nil }
    }

    private var projects: [TaskProject] { TaskOrganizer.projects(in: visibleTasks) }

    private var activeProjectName: String? {
        TaskOrganizer.activeProjectName(tasks: visibleTasks, project: projectFilter.isEmpty ? nil : projectFilter)
    }

    private var grouping: TaskGrouping { TaskGrouping(rawValue: groupingRaw) ?? .parent }

    /// The raw value is JSON keyed by grouping mode, with the legacy newline
    /// format folded into the mode it was saved in. Only the current mode's ids
    /// are read, so one mode's collapses never disturb another's.
    private var collapsedGroups: Set<String> {
        CollapsedGroups.decode(collapsedRaw, legacyMode: groupingRaw).ids(for: groupingRaw)
    }

    private func toggleCollapse(_ id: String) {
        var groups = CollapsedGroups.decode(collapsedRaw, legacyMode: groupingRaw)
        groups.toggle(id, mode: groupingRaw)
        collapsedRaw = groups.encode()
    }

    private var taskGroups: [TaskGroup] {
        TaskOrganizer.organize(
            tasks: visibleTasks,
            project: projectFilter.isEmpty ? nil : projectFilter,
            grouping: grouping
        )
    }

    private var listedTaskIDs: [String] {
        taskGroups.flatMap { TaskOrganizer.visibleTasks(in: $0, collapsed: collapsedGroups) }.map(\.id)
    }

    private func setArchived(_ id: String, _ archived: Bool) {
        let nextID = selection == .task(id)
            ? TaskOrganizer.neighbor(afterRemoving: id, from: listedTaskIDs)
            : nil
        Task {
            let changed = await store.setArchived(id, archived)
            guard changed, selection == .task(id) else { return }
            selection = nextID.map(SidebarSelection.task)
        }
    }

    /// Context menu entries mirror the detail header's preconditions, so a menu
    /// never offers an action the broker would reject.
    private func canCancel(_ task: TaskListItem) -> Bool {
        [.queued, .running, .needsInput, .blocked].contains(TaskState(task.state))
    }

    private func canResume(_ task: TaskListItem) -> Bool {
        [.failed, .cancelled, .blocked].contains(TaskState(task.state))
    }

    private func performCancel(_ id: String) async {
        guard await store.cancelTask(id) else {
            showingTaskActionError = true
            return
        }
    }

    /// Fast path only — the detail header carries the instruction sheet.
    private func performResume(_ id: String) async {
        guard await store.resumeTask(id) else {
            showingTaskActionError = true
            return
        }
    }

    /// Filtering and grouping belong to the task list, so the control sits on the
    /// list's own header rather than in the window toolbar with the global actions.
    private var projectMenu: some View {
        Menu {
            Picker("Tasks", selection: $showArchivedTasks) {
                Text("Active").tag(false)
                Text("Archived").tag(true)
            }
            .pickerStyle(.inline)
            Divider()
            Picker("Project", selection: $projectFilter) {
                Text("All projects").tag("")
                ForEach(projects) { project in
                    Text("\(project.name) — \(project.count)").tag(project.id)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Picker("Group by", selection: $groupingRaw) {
                ForEach(TaskGrouping.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: isFiltering
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease")
                .scaledFont(.caption2, weight: .semibold)
                .foregroundStyle(isFiltering ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Filter and group tasks by project")
        .accessibilityLabel("Filter and group tasks by project")
    }

    private var isFiltering: Bool { activeProjectName != nil || grouping != .parent }

    /// Broker health is app-wide, so it sits at the foot of the sidebar instead of
    /// the toolbar, where it landed on the detail side of the divider and read as
    /// part of the current selection. No word next to it: the light is either on or
    /// it is not, and hover or VoiceOver says which.
    private var brokerIndicator: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.5)
            HStack(spacing: 0) {
                PulsingDot(color: statusColor, diameter: 7 * uiScale, beats: broker.status != .stopped)
                    .frame(width: 24 * uiScale, height: 24 * uiScale)
                    .contentShape(.rect)
                    .help(statusText)
                    .accessibilityLabel(statusText)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
        }
    }

    private var statusText: String {
        switch broker.status { case .running: "Broker online"; case .starting: "Starting…"; case .stopped: "Broker offline" }
    }
    private var statusColor: Color {
        switch broker.status { case .running: .green; case .starting: .orange; case .stopped: .red }
    }
}

/// Collapsible heading for one run of tasks. The count stays visible when the run
/// is closed so a collapsed group never reads as an empty one.
private struct TaskGroupHeader: View {
    let title: String
    let count: Int
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        CollapsibleSection(
            isExpanded: Binding(
                get: { !collapsed },
                set: { expanded in if expanded != !collapsed { toggle() } }
            ),
            label: { SidebarSectionLabel(text: title) },
            trailing: {
                Text("\(count)")
                    .scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary)
            }
        )
        .accessibilityLabel("\(title), \(count) task\(count == 1 ? "" : "s")")
    }
}

private struct ProjectRow: View {
    let project: MemoryProjectSnapshot
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "folder")
                .scaledFont(.callout)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).scaledFont(.body).lineLimit(1)
                Text("\(project.count) memor\(project.count == 1 ? "y" : "ies")")
                    .scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 5)
        .help(project.cwd)
    }
}

private struct TaskRow: View {
    let task: TaskListItem
    let worker: String
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            StateMarker(state: state)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).scaledFont(.body).lineLimit(1)
                Text(meta)
                    .scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 5)
        .help(task.hoverText)
        .accessibilityLabel("\(title). \(state.label). \(worker), \(task.model).")
    }

    private var state: TaskState { TaskState(task.state) }

    /// The check already says "completed", so only unfinished or failed runs spend
    /// a word on their state. Which model ran is worth the width the task id used
    /// to take: a worker's model can change between runs, and the id is one click
    /// away in the task's run details.
    private var meta: String {
        let parts = state.wantsLabelInList
            ? [state.label, worker, task.shortModel]
            : [worker, task.shortModel]
        return parts.joined(separator: " · ")
    }
    private var title: String {
        task.displayLabel
    }
}

private struct InstallResultsView: View {
    @Environment(\.dismiss) private var dismiss
    let results: [MCPConfigInjector.InstallResult]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Global MCP install").font(.title3.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(results.enumerated()), id: \.offset) { _, result in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: result.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(result.success ? .green : .red)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(result.client).fontWeight(.medium)
                                Text("\(result.success ? "Installed" : "Failed") · \(result.message) · \(result.path)")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.never)
        }
        .padding(24)
        .frame(idealWidth: 500, maxHeight: 460)
        .fixedSize(horizontal: true, vertical: false)
    }
}
