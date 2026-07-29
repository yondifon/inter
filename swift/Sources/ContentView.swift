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

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Workers") {
                    ForEach(store.profiles) { profile in
                        WorkerRow(profile: profile).tag(SidebarSelection.profile(profile.id))
                    }
                }
                Section("Recent tasks") {
                    if store.tasks.isEmpty {
                        Text("No tasks yet").font(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(store.tasks) { task in
                            TaskRow(task: task).tag(SidebarSelection.task(task.id))
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 240, ideal: 260)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 7) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                    Text(statusText).font(.callout).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(.bar)
            }
        } detail: {
            if case let .profile(id) = selection,
               let profile = store.profiles.first(where: { $0.id == id }) {
                ProfileDetail(profile: profile, store: store) { editing = profile }
            } else if case let .task(id) = selection,
                      let task = store.tasks.first(where: { $0.id == id }) {
                TaskDetail(task: task, store: store)
            } else {
                ContentUnavailableView("Choose a worker or task", systemImage: "point.3.connected.trianglepath.dotted")
            }
        }
        .toolbar {
            ToolbarItem {
                Button("Install MCP", systemImage: "link.badge.plus") {
                    installResults = MCPConfigInjector.installEverywhere(profiles: store.profiles)
                    showingInstall = true
                }
                .labelStyle(.titleAndIcon)
                .help("Add Inter to every CLI's global MCP config")
            }
            ToolbarItem {
                Button("Add Worker", systemImage: "plus") { adding = true }
                    .help("Add worker")
            }
        }
        .sheet(isPresented: $adding) { ProfileFormView(store: store) }
        .sheet(item: $editing) { ProfileFormView(store: store, profile: $0) }
        .sheet(isPresented: $showingInstall) { InstallResultsView(results: installResults) }
        .task { store.start() }
        .frame(minWidth: 760, minHeight: 520)
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

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    ProviderLogo(provider: profile.provider, size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profile.label).font(.title3.weight(.semibold))
                        Text("\(profile.provider.label) · \(profile.model)")
                            .font(.callout).foregroundStyle(.secondary)
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
                }
                .padding(.vertical, 6)
            }

            Section("Environment") {
                if profile.env.isEmpty {
                    Text("No overrides").foregroundStyle(.secondary)
                } else {
                    ForEach(profile.env.keys.sorted(), id: \.self) { key in
                        EnvironmentRow(key: key, value: profile.env[key] ?? "")
                    }
                }
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
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        CopyButton(text: InterServer.mcpURL)
                    }
                }
            } header: {
                Text("MCP")
            } footer: {
                Text("When enabled, each active worker gets a named tool. Reconnect MCP clients after changing this option or workers.")
            }

        }
        .formStyle(.grouped)
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
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if isSecret {
                    Button { revealed.toggle() } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help(revealed ? "Hide value" : "Reveal value")
                }
                CopyButton(text: value)
            }
        } label: {
            Text(key).font(.system(.callout, design: .monospaced))
        }
    }
}

private struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.plain)
        .foregroundStyle(copied ? Color.green : Color.secondary)
        .help("Copy")
    }
}

private struct WorkerRow: View {
    let profile: Profile

    var body: some View {
        HStack(spacing: 8) {
            ProviderLogo(provider: profile.provider, size: 15)
                .frame(width: 18, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(profile.label).lineLimit(1)
                Text(profile.model).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if !profile.enabled {
                Text("Off").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .opacity(profile.enabled ? 1 : 0.5)
    }
}

private struct TaskRow: View {
    let task: TaskSnapshot

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(stateColor).frame(width: 6, height: 6)
                .frame(width: 18, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(task.prompt).lineLimit(1)
                Text("\(stateLabel) · \(task.model)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 3)
    }

    private var stateLabel: String { task.state.replacingOccurrences(of: "_", with: " ") }
    private var stateColor: Color {
        switch task.state {
        case "failed": .red
        case "completed": .green
        case "needs_input": .orange
        default: .secondary
        }
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
            ForEach(Array(results.enumerated()), id: \.offset) { _, result in
                HStack {
                    Image(systemName: result.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result.success ? .green : .red)
                    VStack(alignment: .leading) {
                        Text(result.client).fontWeight(.medium)
                        Text("\(result.message) · \(result.path)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(24).frame(width: 500)
    }
}
