import SwiftUI

private enum SidebarSelection: Hashable {
    case task(String)
}

struct ContentView: View {
    let store: ProfileStore
    let broker: BrokerManager
    let updateChecker: UpdateChecker
    let openSettings: () -> Void
    @State private var selection: SidebarSelection?
    @State private var installResults: [MCPConfigInjector.InstallResult] = []
    @State private var showingInstall = false
    @State private var showingMemories = false
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
                        Text(emptyTasksText)
                            .scaledFont(.footnote).foregroundStyle(.tertiary)
                    } else {
                        ForEach(taskGroups) { group in
                            if let title = group.title {
                                TaskGroupHeader(
                                    title: title,
                                    count: group.tasks.count,
                                    collapsed: collapsedGroups.contains(group.id)
                                ) { toggleCollapse(group.id) }
                                    .padding(.top, 8)
                                    .help(group.fullTitle ?? group.title ?? group.id)
                            }
                            ForEach(TaskOrganizer.visibleTasks(in: group, collapsed: collapsedGroups)) { task in
                                TaskRow(
                                    task: task,
                                    worker: store.profiles.first { $0.id == task.profileId }?.label ?? task.profileId,
                                    provider: store.profiles.first { $0.id == task.profileId }?.provider
                                )
                                .tag(SidebarSelection.task(task.id))
                                .listRowBackground(sidebarRowFill(selected: selection == .task(task.id)))
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
                        SidebarSectionLabel(
                            text: activeProjectName ?? (showArchivedTasks ? "Archived tasks" : "Recent tasks"),
                            dense: true
                        )
                        Spacer(minLength: 0)
                        if !store.tasks.isEmpty {
                            HStack(spacing: 4) {
                                filterMenu
                                groupMenu
                            }
                        }
                    }
                    // The chips carry their own height, so this header needs less
                    // padding above them than the label-only one below it.
                    .padding(.top, 6)
                    .padding(.bottom, 2)
                    // The header sits outside the List's row-inset chrome, so it needs
                    // its own trailing offset to land on the same edge as a row's
                    // trailing content (the group count below); a row gets this for
                    // free, the header does not.
                    .padding(.trailing, Self.sidebarRowTrailingInset)
                    .background(SystemSelectionHider())
                }
            }
            .listStyle(.sidebar)
            .animation(.easeOut(duration: 0.2), value: visibleTasks)
            .scrollIndicators(.never)
            .safeAreaInset(edge: .bottom) { brokerIndicator }
            // The system sidebar material is translucent and cooler than the content
            // column. A flat neutral fill, run under the titlebar so no seam shows at
            // the toolbar, keeps the whole column one plane.
            .scrollContentBackground(.hidden)
            .background { Surface.sidebar.ignoresSafeArea() }
            .background(SplitViewDividerHider())
            .navigationSplitViewColumnWidth(min: 240, ideal: 260)
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
                    Button("Project Memories", systemImage: "brain") {
                        showingMemories = true
                    }
                    .labelStyle(.iconOnly)
                    .help("See what each project remembers")
                    .accessibilityLabel("See what each project remembers")
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
            } else {
                ContentUnavailableView("Choose a task", systemImage: "point.3.connected.trianglepath.dotted")
            }
        }
        .sheet(isPresented: $showingInstall) { InstallResultsView(results: installResults) }
        .sheet(isPresented: $showingMemories) { ProjectMemoriesSheet(store: store) }
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
            Button("Don’t Cancel", role: .cancel) {}
        } message: { _ in
            Text("This stops the worker’s process tree. The task can be resumed later.")
        }
        .alert("Couldn’t update the task.", isPresented: $showingTaskActionError) {
            Button("OK", role: .cancel) {}
        }
        .safeAreaInset(edge: .bottom) {
            switch updateChecker.state {
            case .updateAvailable(let commit):
                UpdateBanner(commit: commit, updating: false) { updateChecker.installUpdate() }
            case .updating:
                UpdateBanner(commit: nil, updating: true) {}
            default:
                EmptyView()
            }
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

    /// The filter can outlive its project's rows — an empty filtered list is
    /// still a filtered list, so the empty state says whose rows are missing.
    private var emptyTasksText: String {
        guard projectFilter.isEmpty else {
            return showArchivedTasks ? "No archived tasks in this project" : "No tasks in this project"
        }
        return showArchivedTasks ? "No archived tasks" : "No tasks yet"
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

    /// Matches the trailing edge a List row gets automatically (leading is already
    /// consistent between header and row; only the trailing side drifts).
    private static let sidebarRowTrailingInset: CGFloat = 16

    /// Explicit point size, not `scaledFont`: that ladder is tuned for reading-length
    /// text, and a symbol sized off text metrics doesn't carry the same weight.
    private func sidebarIconFont() -> Font {
        .system(size: 15 * uiScale, weight: .semibold)
    }

    /// The system draws no selection fill in this list (`SystemSelectionHider`),
    /// so the current row is marked here instead: a neutral rounded fill, inset
    /// from the column edges, that leaves the row's text and state dot at the
    /// colors they carry when the row is not selected.
    private func sidebarRowFill(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radius.small)
            .fill(selected ? Surface.selection : Color.clear)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
    }

    /// Both menus rest on a raised chip. A bare symbol on the sidebar fill has
    /// only its own stroke to hold it apart from the ground, which reads as more
    /// header rather than as a control; the chip gives it a control-shaped edge
    /// and full-strength ink keeps the stroke itself legible. A control holding a
    /// non-default value swaps the raised chip for a recessed one and fills its
    /// symbol.
    private func sidebarMenuChip(active: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radius.small)
            .fill(active ? Surface.selection : Surface.panel)
    }

    /// Status (active/archived) and project both narrow which rows show, so they
    /// share one menu; grouping changes how the same rows are arranged and gets
    /// its own. The rightmost control owns the shared trailing edge.
    private var filterMenu: some View {
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
        } label: {
            Image(systemName: isFiltering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(sidebarIconFont())
                .imageScale(.large)
                .foregroundStyle(Color.primary)
                .frame(width: 28 * uiScale, height: 28 * uiScale)
                .background(sidebarMenuChip(active: isFiltering))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Filter tasks by project or status")
        .accessibilityLabel("Filter tasks by project or status")
    }

    private var groupMenu: some View {
        Menu {
            Picker("Group by", selection: $groupingRaw) {
                ForEach(TaskGrouping.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: isGroupingCustom ? "rectangle.3.group.fill" : "rectangle.3.group")
                .font(sidebarIconFont())
                .imageScale(.large)
                .foregroundStyle(Color.primary)
                .frame(width: 28 * uiScale, height: 28 * uiScale)
                .background(sidebarMenuChip(active: isGroupingCustom))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Group tasks")
        .accessibilityLabel("Group tasks")
    }

    private var isFiltering: Bool { !projectFilter.isEmpty || showArchivedTasks }
    private var isGroupingCustom: Bool { grouping != .parent }

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
        switch broker.status { case .running: "Broker running"; case .starting: "Starting…"; case .stopped: "Broker offline" }
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
            label: { SidebarSectionLabel(text: title, dense: true) },
            trailing: {
                Text("\(count)")
                    .scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary)
            }
        )
        .accessibilityLabel("\(title), \(count) task\(count == 1 ? "" : "s")")
    }
}

private struct TaskRow: View {
    let task: TaskListItem
    let worker: String
    let provider: Provider?
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            StateMarker(state: state, diameter: 6)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).scaledFont(.callout).lineLimit(1)
                HStack(spacing: 3 * uiScale) {
                    if let metaPrefix {
                        Text(metaPrefix)
                    }
                    // Fixed width whether or not a mark draws, so rows with and
                    // without one still align on the worker name.
                    Group {
                        if let provider {
                            ProviderLogo(provider: provider, size: 7 * uiScale)
                        }
                    }
                    .frame(width: 7 * uiScale, alignment: .center)
                    Text(metaSuffix)
                }
                .scaledFont(.caption2, design: .monospaced)
                .foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 5)
        .help(helpText)
        .accessibilityLabel("\(title). \(state.label). \(worker), \(task.model).")
    }

    private var state: TaskState { TaskState(task.state) }

    /// The check already says "completed", so only unfinished or failed runs spend
    /// a word on their state. Which model ran is worth the width the task id used
    /// to take: a worker's model can change between runs, and the id is one click
    /// away in the task's run details.
    private var metaPrefix: String? {
        state.wantsLabelInList ? "\(state.label) ·" : nil
    }
    private var metaSuffix: String { "\(worker) · \(task.shortModel)" }
    private var meta: String {
        let parts = state.wantsLabelInList
            ? [state.label, worker, task.shortModel]
            : [worker, task.shortModel]
        return parts.joined(separator: " · ")
    }

    /// The row clips the meta line to one line, so the hover carries it whole —
    /// a long model name is otherwise unrecoverable.
    private var helpText: String {
        "\(task.hoverText)\n\n\(meta)"
    }
    private var title: String {
        task.displayLabel
    }
}

/// Sits under the sidebar and detail columns, not inside either — an update
/// concerns the whole app, not the current selection.
private struct UpdateBanner: View {
    let commit: String?
    let updating: Bool
    let onUpdate: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if updating {
                ProgressView().controlSize(.small)
                Text("Updating — rebuilding from source, app will relaunch (log: \(UpdateChecker.updateLogPath))")
                    .scaledFont(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "arrow.down.circle.fill")
                    .scaledFont(.callout)
                    .foregroundStyle(.tint)
                Text("Update available — \(commit.map { String($0.prefix(7)) } ?? "new commit") on remote")
                    .scaledFont(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !updating {
                Button("Update & Relaunch", action: onUpdate)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Surface.content)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1)
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// A project's memories, in a sheet: a picker column of projects on the left,
/// the chosen one's memories on the right. Master-detail rather than a plain
/// list-then-push, because a reader comparing what two projects remember
/// shouldn't lose the list to see the second one.
private struct ProjectMemoriesSheet: View {
    let store: ProfileStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            NavigationSplitView {
                List(store.memoryProjects, selection: $selection) { project in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name)
                            .scaledFont(.callout).lineLimit(1)
                        Text("\(project.count) memor\(project.count == 1 ? "y" : "ies")")
                            .scaledFont(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .tag(project.cwd)
                    .background(SystemSelectionHider())
                    .listRowBackground(rowFill(selected: selection == project.cwd))
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .background { Surface.sidebar }
                .navigationSplitViewColumnWidth(min: 180, ideal: 220)
            } detail: {
            if let cwd = selection, let project = store.memoryProjects.first(where: { $0.cwd == cwd }) {
                ProjectMemoryView(project: project, store: store)
                    .id(project.cwd)
            } else if store.memoryProjects.isEmpty {
                ContentUnavailableView(
                    "No project memories yet",
                    systemImage: "brain",
                    description: Text("Once a project stores something worth remembering, it will show up here.")
                )
            } else {
                ContentUnavailableView("Choose a project", systemImage: "folder")
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .background { Surface.content.ignoresSafeArea() }
        .frame(minWidth: 760, minHeight: 480)
    }
    }

    /// The sheet's own top edge; a NavigationSplitView carries no title of its
    /// own, and this is a sheet, not a view inside the window that reports where
    /// it sits.
    private var titleBar: some View {
        HStack(spacing: 8) {
            Text("Project Memories").scaledFont(.title3, weight: .semibold)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    /// Same neutral pill the task sidebar uses to mark the current row; the
    /// selection state drives it and the highlight style is hidden on the list.
    private func rowFill(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radius.small)
            .fill(selected ? Surface.selection : Color.clear)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
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
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(results.enumerated()), id: \.offset) { _, result in
                        HStack(alignment: .center, spacing: 8) {
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
