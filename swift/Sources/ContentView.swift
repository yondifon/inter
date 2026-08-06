import SwiftUI

private enum SidebarSelection: Hashable {
    case task(String)
}

/// The sidebar column's live width, carried up from a background probe so the
/// value the user last dragged to can be written to defaults.
private struct SidebarWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// One-time bridge from the old boolean archive toggle to the three-way
/// filter. `LegacyDefaults.swift` (the usual home for a defaults migration)
/// and `main.swift` (where migrations run before any view is built) are both
/// out of scope for this change, so this runs from `ContentView`'s own
/// `.task` instead; the marker makes every later relaunch a no-op.
private enum TaskArchiveFilterMigration {
    private static let marker = "migratedTaskArchiveFilterDefaults"
    private static let legacyKey = "showArchivedTasks"

    static func runIfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: marker) else { return }
        defaults.set(true, forKey: marker)
        guard defaults.object(forKey: "taskArchiveFilter") == nil else { return }
        let wasArchivedOnly = defaults.bool(forKey: legacyKey)
        defaults.set(
            (wasArchivedOnly ? TaskArchiveFilter.archived : TaskArchiveFilter.active).rawValue,
            forKey: "taskArchiveFilter"
        )
    }
}

struct ContentView: View {
    let store: ProfileStore
    let broker: BrokerManager
    let updateChecker: UpdateChecker
    @ObservedObject var settingsPresentation: SettingsPresentation
    @State private var selection: SidebarSelection?
    @State private var installResults: [MCPConfigInjector.InstallResult] = []
    @State private var showingInstall = false
    @AppStorage("taskProjectFilter") private var projectFilter = ""
    @AppStorage("taskGrouping") private var groupingRaw = TaskGrouping.parent.rawValue
    @AppStorage("taskSort") private var sortRaw = TaskSort.priority.rawValue
    @AppStorage("collapsedTaskGroups") private var collapsedRaw = ""
    @AppStorage("taskArchiveFilter") private var archiveFilterRaw = TaskArchiveFilter.active.rawValue
    @AppStorage("taskSidebarWidth") private var sidebarWidth = 260.0
    @State private var taskPendingCancel: String?
    @State private var taskPendingComplete: String?
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
                                    if canComplete(task) {
                                        Button("Mark as completed", systemImage: "checkmark.circle") {
                                            taskPendingComplete = task.id
                                        }
                                    }
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
                                    // The "All" filter mixes active and archived rows, so the
                                    // action reflects this row's own state, not the filter.
                                    Button(task.archivedAt != nil ? "Restore" : "Archive",
                                           systemImage: task.archivedAt != nil ? "arrow.uturn.backward" : "archivebox") {
                                        setArchived(task.id, task.archivedAt == nil)
                                    }
                                }
                                // Right-clicking a row moves AppKit's real selection to it before
                                // the menu opens, which is why `sidebarRowFill` above already
                                // themes it; this only strips the system's own focus ring drawn on
                                // top of that, the stock blue rounded rectangle.
                                .focusEffectDisabled()
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        SidebarSectionLabel(
                            text: activeProjectName ?? sidebarSectionTitle,
                            dense: false
                        )
                        Spacer(minLength: 0)
                        if !store.tasks.isEmpty {
                            viewMenu
                        }
                    }
                    // The control carries its own height, so this header needs less
                    // padding above it than the label-only one below it.
                    .padding(.top, 6)
                    .padding(.bottom, 10)
                    // The header sits outside the List's row-inset chrome, so it needs
                    // its own trailing offset to land on the same edge as a row's
                    // trailing content (the group count below); a row gets this for
                    // free, the header does not.
                    .padding(.trailing, Self.sidebarRowTrailingInset)
                    .background(SystemSelectionHider())
                } footer: {
                    loadMoreFooter
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
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: SidebarWidthKey.self, value: proxy.size.width)
                }
            }
            .onPreferenceChange(SidebarWidthKey.self) { width in
                persistSidebarWidth(width)
            }
            .navigationSplitViewColumnWidth(min: Self.minSidebarWidth, ideal: restoredSidebarWidth, max: Self.maxSidebarWidth)
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
                    Button("Settings…", systemImage: "gearshape") { settingsPresentation.isPresented = true }
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
        .sheet(isPresented: $settingsPresentation.isPresented) { SettingsView(store: store, broker: broker) }
        .task {
            TaskArchiveFilterMigration.runIfNeeded()
            // Read the just-migrated value straight from defaults rather than
            // through `archiveFilterRaw`: `@AppStorage` only picks up this
            // process's own write via its own change notification, and the
            // store's first fetch shouldn't have to wait on that round trip.
            let initialFilter = TaskArchiveFilter(rawValue: UserDefaults.standard.string(forKey: "taskArchiveFilter") ?? "") ?? .active
            store.start(archiveFilter: initialFilter)
        }
        .onChange(of: archiveFilterRaw) { _, newValue in
            Task { await store.setArchiveFilter(TaskArchiveFilter(rawValue: newValue) ?? .active) }
        }
        // Both sidebar actions settle the task, so each confirms first.
        .confirmationDialog(
            "Mark this task as completed?",
            isPresented: Binding(
                get: { taskPendingComplete != nil },
                set: { if !$0 { taskPendingComplete = nil } }
            ),
            titleVisibility: .visible,
            presenting: taskPendingComplete
        ) { id in
            Button("Mark as completed") {
                Task { await performComplete(id) }
            }
            Button("Don’t Mark Completed", role: .cancel) {}
        } message: { id in
            Text(completionDialogMessage(for: id))
        }
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

    /// Already filtered and paged server-side — the broker only ever sends
    /// rows matching `archiveFilter`, up to whatever's currently loaded.
    private var visibleTasks: [TaskListItem] { store.tasks }

    private var archiveFilter: TaskArchiveFilter { TaskArchiveFilter(rawValue: archiveFilterRaw) ?? .active }

    private var projects: [TaskProject] { TaskOrganizer.projects(in: visibleTasks) }

    private var activeProjectName: String? {
        TaskOrganizer.activeProjectName(tasks: visibleTasks, project: projectFilter.isEmpty ? nil : projectFilter)
    }

    private var sidebarSectionTitle: String {
        switch archiveFilter {
        case .all: "All tasks"
        case .active: "Recent tasks"
        case .archived: "Archived tasks"
        }
    }

    /// The filter can outlive its project's rows — an empty filtered list is
    /// still a filtered list, so the empty state says whose rows are missing.
    private var emptyTasksText: String {
        switch archiveFilter {
        case .all, .active:
            return projectFilter.isEmpty ? "No tasks yet" : "No tasks in this project"
        case .archived:
            return projectFilter.isEmpty ? "No archived tasks" : "No archived tasks in this project"
        }
    }

    private var grouping: TaskGrouping { TaskGrouping(rawValue: groupingRaw) ?? .parent }
    private var sort: TaskSort { TaskSort(rawValue: sortRaw) ?? .priority }

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
            grouping: grouping,
            sort: sort
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

    /// A task that will not end on its own can be force-settled — the broker
    /// stops any live worker first. A completed task is already settled, so the
    /// action is a no-op there and stays hidden.
    private func canComplete(_ task: TaskListItem) -> Bool {
        [.queued, .running, .needsInput, .answered, .blocked, .failed, .cancelled].contains(TaskState(task.state))
    }

    private func performCancel(_ id: String) async {
        guard await store.cancelTask(id) else {
            showingTaskActionError = true
            return
        }
    }

    private func performComplete(_ id: String) async {
        guard await store.markTaskCompleted(id) else {
            showingTaskActionError = true
            return
        }
    }

    /// The dialog spells out what the action does, and that depends on whether a
    /// worker can still be running: live or parked states have a process tree to
    /// stop, a failed or cancelled run has already ended.
    private func completionDialogMessage(for id: String) -> String {
        let liveStates = [TaskState.queued, .running, .needsInput, .answered, .blocked]
        let hasLiveWorker = store.tasks.first { $0.id == id }
            .map { liveStates.contains(TaskState($0.state)) } ?? false
        return hasLiveWorker
            ? "This stops the worker’s process tree and marks the task completed."
            : "Marks the task completed. The run has already ended, so no worker is stopped."
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

    /// Sidebar column bounds, so a corrupt stored width can't shrink the pane to
    /// nothing or shove the detail column off the window.
    private static let minSidebarWidth: CGFloat = 240
    private static let maxSidebarWidth: CGFloat = 560

    /// The restored width, clamped to `minSidebarWidth`…`maxSidebarWidth`.
    private var restoredSidebarWidth: CGFloat {
        let width = CGFloat(sidebarWidth)
        return min(max(width, Self.minSidebarWidth), Self.maxSidebarWidth)
    }

    /// Records the column as the user left it. Below `minSidebarWidth` the window,
    /// not the user, set the width — a squeezed pane is not worth remembering.
    /// Stored whole points, so the saved value stays clean.
    private func persistSidebarWidth(_ width: CGFloat) {
        guard width >= Self.minSidebarWidth else { return }
        let clamped = min(max(width, Self.minSidebarWidth), Self.maxSidebarWidth).rounded()
        guard abs(clamped - CGFloat(sidebarWidth)) > 0.5 else { return }
        sidebarWidth = Double(clamped)
    }

    /// Explicit point size, not `scaledFont`: that ladder is tuned for reading-length
    /// text, and a symbol sized off text metrics doesn't carry the same weight.
    private func sidebarIconFont() -> Font {
        .system(size: 19 * uiScale, weight: .semibold)
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

    /// The menu rests on a raised chip. A bare symbol on the sidebar fill has
    /// only its own stroke to hold it apart from the ground, which reads as more
    /// header rather than as a control; the chip gives it a control-shaped edge
    /// and full-strength ink keeps the stroke itself legible. A control holding a
    /// non-default value swaps the raised chip for a recessed one and fills its
    /// symbol.
    private func sidebarMenuChip(active: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radius.small)
            .fill(active ? Surface.selection : Surface.panel)
    }

    /// Grouping splits rows into sections, sorting orders the rows inside each
    /// section, and the filter narrows which rows show at all — one menu holds
    /// all three. The control owns the shared trailing edge.
    private var viewMenu: some View {
        Menu {
            Picker("Group by", selection: $groupingRaw) {
                ForEach(TaskGrouping.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Picker("Sort by", selection: $sortRaw) {
                ForEach(TaskSort.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Picker("Filter", selection: $archiveFilterRaw) {
                ForEach(TaskArchiveFilter.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.inline)
            Menu {
                Picker("Project", selection: $projectFilter) {
                    Text("All projects").tag("")
                    ForEach(projects) { project in
                        Text("\(project.name) — \(project.count)").tag(project.id)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Text(projectMenuLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        } label: {
            Image(systemName: viewMenuIsActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(sidebarIconFont())
                .imageScale(.large)
                .foregroundStyle(Color.primary)
                .frame(width: 36 * uiScale, height: 36 * uiScale)
                .background(sidebarMenuChip(active: viewMenuIsActive))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Group, sort, and filter tasks")
        .accessibilityLabel("Group, sort, and filter tasks")
    }

    private var viewMenuIsActive: Bool { grouping != .parent || sort != .priority || isFiltering }
    private var isFiltering: Bool { !projectFilter.isEmpty || archiveFilter != .active }

    /// Sits below the last group as the List section's own footer, so it
    /// scrolls with the rows instead of floating over them. Hidden once the
    /// broker says there is nothing left to page in — a live button that
    /// always returns nothing is worse than no button.
    @ViewBuilder
    private var loadMoreFooter: some View {
        if store.tasksHasMore {
            Button {
                Task { await store.loadMoreTasks() }
            } label: {
                HStack(spacing: 6) {
                    if store.isLoadingMoreTasks {
                        ProgressView().controlSize(.small)
                        Text("Loading…")
                    } else if store.loadMoreFailed {
                        Image(systemName: "arrow.clockwise")
                        Text("Couldn’t load more — tap to retry")
                    } else {
                        Text("Load more")
                    }
                }
                .frame(maxWidth: .infinity)
                .scaledFont(.footnote)
                .foregroundStyle(store.loadMoreFailed ? Color.red : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(store.isLoadingMoreTasks)
            .padding(.vertical, 8)
        }
    }

    /// The project submenu's collapsed label names the active filter, so the
    /// current selection is visible without opening it.
    private var projectMenuLabel: String {
        guard !projectFilter.isEmpty else { return "Project: All" }
        return "Project: \(TaskOrganizer.projectName(projectFilter))"
    }

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
                // Cost first since it reads at a glance, tokens after it: at a
                // narrow sidebar width, tail truncation drops the token count
                // before it ever touches the dollar figure.
                if let summary = store.spend?.summary {
                    Text(summary)
                        .scaledFont(.caption2, design: .monospaced)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help("\(summary) over the last 24 hours")
                        .accessibilityLabel("\(summary) over the last 24 hours")
                }
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
                .foregroundStyle(.secondary).lineLimit(1)
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
