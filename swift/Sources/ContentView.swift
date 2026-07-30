import SwiftUI

private enum SidebarSelection: Hashable {
    case profile(String)
    case task(String)
}

struct ContentView: View {
    let store: ProfileStore
    let broker: BrokerManager
    @State private var selection: SidebarSelection?
    @State private var editing: Profile?
    @State private var adding = false
    @State private var installResults: [MCPConfigInjector.InstallResult] = []
    @State private var showingInstall = false
    @AppStorage("taskProjectFilter") private var projectFilter = ""
    @AppStorage("taskGroupByProject") private var groupByProject = false
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    if store.profiles.isEmpty {
                        Text("No workers yet. Add one to start delegating.")
                            .scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(store.profiles) { profile in
                            WorkerRow(profile: profile).tag(SidebarSelection.profile(profile.id))
                        }
                    }
                } header: {
                    SectionLabel(text: "Workers")
                }
                Section {
                    if store.tasks.isEmpty {
                        Text("No tasks yet").scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(taskGroups) { group in
                            if let title = group.title {
                                SectionLabel(text: title)
                                    .padding(.top, 4)
                                    .help(group.id)
                            }
                            ForEach(group.tasks) { task in
                                TaskRow(
                                    task: task,
                                    worker: store.profiles.first { $0.id == task.profileId }?.label ?? task.profileId
                                )
                                .tag(SidebarSelection.task(task.id))
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        SectionLabel(text: activeProjectName ?? "Recent tasks")
                        Spacer(minLength: 0)
                        if store.tasks.count > 1 { projectMenu }
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollIndicators(.never)
            .navigationSplitViewColumnWidth(min: 240, ideal: 260)
            // Graphite-style selection. The system accent turns a scanned list into
            // a blue slab; a neutral fill keeps the type as the loudest thing.
            .tint(Color(nsColor: .systemGray))
            .toolbar {
                ToolbarItem(placement: .navigation) { brokerIndicator }
                ToolbarItem {
                    Button("Install MCP", systemImage: "link.badge.plus") {
                        installResults = MCPConfigInjector.installEverywhere(profiles: store.profiles)
                        showingInstall = true
                    }
                    .labelStyle(.iconOnly)
                    .help("Add Inter to every CLI's global MCP config")
                }
                ToolbarItem {
                    Button("Add Worker", systemImage: "plus") { adding = true }
                        .help("Add worker")
                }
            }
        } detail: {
            if case let .profile(id) = selection,
               let profile = store.profiles.first(where: { $0.id == id }) {
                ProfileDetail(profile: profile, store: store) { editing = profile }
            } else if case let .task(id) = selection,
                      let task = store.tasks.first(where: { $0.id == id }) {
                TaskDetail(task: task, store: store)
                    .id(task.id)
            } else {
                ContentUnavailableView("Choose a worker or task", systemImage: "point.3.connected.trianglepath.dotted")
            }
        }
        .sheet(isPresented: $adding) { ProfileFormView(store: store) }
        .sheet(item: $editing) { ProfileFormView(store: store, profile: $0) }
        .sheet(isPresented: $showingInstall) { InstallResultsView(results: installResults) }
        .task { store.start() }
        .frame(minWidth: 760, minHeight: 520)
    }

    private var projects: [TaskProject] { TaskOrganizer.projects(in: store.tasks) }

    private var activeProjectName: String? {
        TaskOrganizer.activeProjectName(tasks: store.tasks, project: projectFilter.isEmpty ? nil : projectFilter)
    }

    private var taskGroups: [TaskGroup] {
        TaskOrganizer.organize(
            tasks: store.tasks,
            project: projectFilter.isEmpty ? nil : projectFilter,
            grouped: groupByProject
        )
    }

    /// Filtering and grouping belong to the task list, so the control sits on the
    /// list's own header rather than in the window toolbar with the global actions.
    private var projectMenu: some View {
        Menu {
            Picker("Project", selection: $projectFilter) {
                Text("All projects").tag("")
                ForEach(projects) { project in
                    Text("\(project.name) — \(project.count)").tag(project.id)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Toggle("Group by project", isOn: $groupByProject)
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

    private var isFiltering: Bool { activeProjectName != nil || groupByProject }

    /// Broker health is app-wide, so it sits above the sidebar with the other
    /// global controls instead of in the detail toolbar, where it read as part of
    /// the current selection.
    private var brokerIndicator: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 7 * uiScale, height: 7 * uiScale)
                .accessibilityHidden(true)
            Text(statusText).scaledFont(.caption).foregroundStyle(.secondary)
        }
        .fixedSize()
        .help(statusText)
    }

    private var statusText: String {
        switch broker.status { case .running: "Broker online"; case .starting: "Starting…"; case .stopped: "Broker offline" }
    }
    private var statusColor: Color {
        switch broker.status { case .running: .green; case .starting: .orange; case .stopped: .red }
    }
}

private struct ProfileDetail: View {
    let profile: Profile
    let store: ProfileStore
    let edit: () -> Void

    @State private var confirmingDelete = false
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    ProviderLogo(provider: profile.provider, size: 28 * uiScale)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profile.label).scaledFont(.title3, weight: .semibold)
                        Text("\(profile.provider.label) · \(profile.model)")
                            .scaledFont(.callout, design: .monospaced).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 16)
                    EnabledToggle(profile: profile, store: store)
                    Button("Edit…", action: edit)
                    Menu {
                        Button("Delete Worker…", role: .destructive) { confirmingDelete = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("More actions")
                    .accessibilityLabel("More actions")
                }
                .padding(.vertical, 6)
            }

            Section {
                if profile.env.isEmpty {
                    Text("No overrides").foregroundStyle(.secondary)
                } else {
                    ForEach(profile.env.keys.sorted(), id: \.self) { key in
                        EnvironmentRow(key: key, value: profile.env[key] ?? "")
                    }
                }
            } header: {
                SectionLabel(text: "Environment")
            }

            Section {
                Toggle("Named worker tools", isOn: Binding(
                    get: { store.settings.dynamicProfileTools },
                    set: { enabled in Task { await store.setDynamicProfileTools(enabled) } }
                ))
                .toggleStyle(.switch)
                LabeledContent("Endpoint") {
                    HStack(spacing: 8) {
                        Text(InterServer.mcpURL)
                            .scaledFont(.body, design: .monospaced)
                            .textSelection(.enabled)
                        CopyIconButton(text: InterServer.mcpURL, label: "Copy endpoint")
                    }
                }
            } header: {
                SectionLabel(text: "MCP — applies to all workers")
            } footer: {
                Text("When enabled, each active worker gets a named tool. Reconnect MCP clients after changing this option or workers.")
            }

        }
        .formStyle(.grouped)
        .scrollIndicators(.never)
        .confirmationDialog("Delete “\(profile.label)”?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive) { Task { await store.delete(profile) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Delegated tasks can no longer use this worker. This can’t be undone.")
        }
    }
}

private struct EnvironmentRow: View {
    let key: String
    let value: String
    @State private var revealed = false

    private var isSecret: Bool {
        ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"].contains { key.uppercased().contains($0) }
    }

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                Text(isSecret && !revealed ? String(repeating: "•", count: 10) : value)
                    .scaledFont(.body, design: .monospaced)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if isSecret {
                    IconButton(
                        symbol: revealed ? "eye.slash" : "eye",
                        label: revealed ? "Hide value" : "Reveal value"
                    ) { revealed.toggle() }
                }
                CopyIconButton(text: value, label: "Copy value")
            }
        } label: {
            Text(key).scaledFont(.callout, design: .monospaced)
        }
    }
}

private struct WorkerRow: View {
    let profile: Profile
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 8) {
            ProviderLogo(provider: profile.provider, size: 15 * uiScale)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(profile.label).scaledFont(.body).lineLimit(1)
                Text(profile.model).scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if !profile.enabled {
                Text("Off").scaledFont(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .opacity(profile.enabled ? 1 : 0.5)
    }
}

private struct TaskRow: View {
    let task: TaskSnapshot
    let worker: String
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 8) {
            StateMarker(state: state)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).scaledFont(.body).lineLimit(1)
                Text(meta)
                    .scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .help(task.prompt)
        .accessibilityLabel("\(title). \(state.label). \(worker).")
    }

    private var state: TaskState { TaskState(task.state) }

    /// The check already says "completed", so only unfinished or failed runs spend
    /// a word on their state.
    private var meta: String {
        let parts = state.wantsLabelInList
            ? [state.label, worker, shortID]
            : [worker, shortID]
        return parts.joined(separator: " · ")
    }

    private var shortID: String { "#\(task.id.prefix(8))" }
    private var title: String {
        task.prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Untitled task"
    }
}

struct EnabledToggle: View {
    let profile: Profile
    let store: ProfileStore
    @State private var saveFailed = false

    var body: some View {
        Toggle("Enabled", isOn: Binding(
            get: { profile.enabled },
            set: { value in
                var changed = profile
                changed.enabled = value
                Task {
                    do { try await store.save(changed, isNew: false) } catch { saveFailed = true }
                }
            }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
        .accessibilityLabel("Enabled")
        .help(profile.enabled ? "Accepts delegated tasks" : "Hidden from delegate")
        .alert("Couldn’t change worker state.", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        }
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
