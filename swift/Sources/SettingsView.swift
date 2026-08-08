import SwiftUI

enum SettingsSelection: Hashable {
    case worker(String)
    case memoryProject(String)
    case about
}

/// Shared flag that opens the Settings sheet from anywhere — the toolbar
/// button and ⌘, (see `AppDelegate.openSettings` in main.swift) both just
/// flip `isPresented`.
final class SettingsPresentation: ObservableObject {
    @Published var isPresented = false
}

/// Settings content, presented as a sheet over the main window (see
/// `ContentView`'s `.sheet(isPresented:)` binding to `SettingsPresentation`).
struct SettingsView: View {
    let store: ProfileStore
    let broker: BrokerManager
    @Environment(\.dismiss) private var dismiss
    @State private var selection: SettingsSelection?
    @State private var editing: Profile?
    @State private var adding = false
    @AppStorage("settingsWorkersExpanded") private var workersExpanded = true
    @AppStorage("settingsMemoriesExpanded") private var memoriesExpanded = true

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            NavigationSplitView {
            List(selection: $selection) {
                CollapsibleSection(
                    isExpanded: $workersExpanded,
                    label: { SidebarSectionLabel(text: "Workers") }
                )
                if workersExpanded {
                    if store.profiles.isEmpty {
                        Text("No workers yet. Add one to start delegating.")
                            .scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(store.profiles) { profile in
                            WorkerRow(profile: profile)
                                .tag(SettingsSelection.worker(profile.id))
                                .background(SystemSelectionHider())
                                .listRowBackground(rowFill(selected: selection == .worker(profile.id)))
                        }
                    }
                }

                CollapsibleSection(
                    isExpanded: $memoriesExpanded,
                    label: { SidebarSectionLabel(text: "Memories") }
                )
                if memoriesExpanded {
                    if store.memoryProjects.isEmpty {
                        Text("No memories yet. They land here once an agent stores one.")
                            .scaledFont(.callout).foregroundStyle(.tertiary)
                    } else {
                        ForEach(store.memoryProjects) { project in
                            MemoryProjectRow(project: project)
                                .tag(SettingsSelection.memoryProject(project.cwd))
                                .background(SystemSelectionHider())
                                .listRowBackground(rowFill(selected: selection == .memoryProject(project.cwd)))
                        }
                    }
                }

                AboutRow()
                    .tag(SettingsSelection.about)
                    .background(SystemSelectionHider())
                    .listRowBackground(rowFill(selected: selection == .about))
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.never)
            .background { Surface.content }
            .background(SplitViewDividerHider())
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
        } detail: {
            switch selection {
            case .worker(let id):
                if let profile = store.profiles.first(where: { $0.id == id }) {
                    ProfileDetail(profile: profile, store: store) { editing = profile }
                        .id(profile.id)
                } else {
                    ContentUnavailableView("Choose a worker", systemImage: "person.2")
                }
            case .memoryProject(let cwd):
                if let project = store.memoryProjects.first(where: { $0.cwd == cwd }) {
                    ProjectMemoryView(project: project, store: store)
                        .id(project.cwd)
                } else {
                    ContentUnavailableView("Choose a project", systemImage: "folder")
                }
            case .about:
                AboutPage(broker: broker)
            case nil:
                ContentUnavailableView("Choose a worker", systemImage: "person.2")
            }
        }
        .background(Surface.content)
        .sheet(isPresented: $adding) { ProfileFormView(store: store) }
        .sheet(item: $editing) { ProfileFormView(store: store, profile: $0) }
        // A worker deleted from the detail pane leaves `selection` pointing at a
        // profile that no longer exists; fall back to the empty state instead of
        // stranding the detail pane on stale data.
        .onChange(of: store.profiles) { _, profiles in
            if case let .worker(id) = selection, !profiles.contains(where: { $0.id == id }) {
                self.selection = nil
            }
        }
        .onChange(of: store.memoryProjects) { _, projects in
            if case let .memoryProject(cwd) = selection, !projects.contains(where: { $0.cwd == cwd }) {
                self.selection = nil
            }
        }
            footer
        }
        .background { Surface.content.ignoresSafeArea() }
        .frame(minWidth: 760, minHeight: 480)
    }

    /// The sheet's own top edge; a NavigationSplitView carries no title of its
    /// own, and this is a sheet, not a window that reports one via its titlebar.
    private var titleBar: some View {
        HStack(spacing: 8) {
            Text("Settings").scaledFont(.title3, weight: .semibold)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    /// Bottom bar, not a window toolbar: a sheet carries no titlebar of its own
    /// for `ToolbarItem`s to dock into, so "Add Worker" and "Done" fell to a
    /// stock bottom bar by default. Making the bar explicit gives it the app's
    /// own surface and button treatment instead of that system chrome.
    private var footer: some View {
        HStack {
            Button("+ Add Worker") { adding = true }
                .buttonStyle(.borderedProminent)
            Spacer(minLength: 0)
            Button("Done") { dismiss() }
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Surface.content)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1)
        }
    }

    /// Same neutral pill every section uses to mark the current row — the
    /// sidebar's own selection state drives it, not the system highlight.
    private func rowFill(selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radius.small)
            .fill(selected ? Surface.selection : Color.clear)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
    }
}

private struct AboutRow: View {
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "info.circle")
                .font(.system(size: 13 * uiScale))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            Text("About").scaledFont(.callout)
        }
        .padding(.vertical, 5)
    }
}

struct AboutPage: View {
    let broker: BrokerManager
    @State private var health: BrokerHealth?
    @State private var fetchFailed = false

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 12) {
                Image(nsImage: InterMark.appIcon(side: 80))
                    .resizable()
                    .frame(width: 80, height: 80)

                VStack(spacing: 4) {
                    Text("Inter").font(.title2.weight(.semibold))
                    Text("Version \(appVersion) (\(buildNumber))")
                        .scaledFont(.callout, design: .monospaced)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            if let health {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        PulsingDot(color: .green, diameter: 7, beats: false)
                        Text("Inter running").scaledFont(.callout, weight: .medium)
                    }

                    LabeledContent("Version", value: health.version)
                    LabeledContent("Connection version", value: "v\(health.mcpContractVersion)")

                    Text(health.build)
                        .scaledFont(.caption, design: .monospaced)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
            } else if fetchFailed {
                HStack(spacing: 8) {
                    Circle().fill(.red).frame(width: 7, height: 7)
                    Text("Inter unreachable").scaledFont(.callout)
                        .foregroundStyle(.secondary)
                }
            } else {
                ProgressView("Checking Inter…").controlSize(.small)
            }

            Spacer()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Re-run when the broker state settles, so a start that outlived the
        // one-shot fetch still reconciles to "Inter running".
        .task(id: broker.status) { await fetch() }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }

    private func fetch() async {
        if let result = await broker.fetchHealth() {
            health = result
        } else {
            fetchFailed = true
        }
    }
}

private struct ProfileDetail: View {
    let profile: Profile
    let store: ProfileStore
    let edit: () -> Void

    @State private var confirmingDelete = false
    @State private var deleteFailed = false
    @Environment(\.uiScale) private var uiScale

    private var sortedEnvKeys: [String] { profile.env.keys.sorted() }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.vertical, 14 * uiScale)
                Divider()

                VStack(alignment: .leading, spacing: 0) {
                    SidebarSectionLabel(text: "Environment")
                        .padding(.top, 18 * uiScale)
                        .padding(.bottom, 6 * uiScale)
                    if profile.env.isEmpty {
                        Text("No overrides")
                            .scaledFont(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 6 * uiScale)
                    } else {
                        ForEach(sortedEnvKeys, id: \.self) { key in
                            EnvironmentRow(key: key, value: profile.env[key] ?? "")
                            if key != sortedEnvKeys.last {
                                Divider()
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 6 * uiScale) {
                    SidebarSectionLabel(text: "Connection")
                        .padding(.top, 18 * uiScale)
                    LabeledContent("Endpoint") {
                        HStack(spacing: 8 * uiScale) {
                            Text(InterServer.mcpURL)
                                .scaledFont(.body, design: .monospaced)
                                .textSelection(.enabled)
                            CopyIconButton(text: InterServer.mcpURL, label: "Copy endpoint")
                        }
                    }
                    .padding(.vertical, 6 * uiScale)
                    Text("Shared by every worker — reconnect your CLIs after changing it.")
                        .scaledFont(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20 * uiScale)
            .padding(.bottom, 20 * uiScale)
        }
        .background(Surface.content)
        .scrollIndicators(.never)
        .confirmationDialog("Delete “\(profile.label)”?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive) {
                Task {
                    if !(await store.delete(profile)) { deleteFailed = true }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Delegated tasks can no longer use this worker. This can’t be undone.")
        }
        .alert("Couldn’t delete worker. Try again.", isPresented: $deleteFailed) {
            Button("OK", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(spacing: 14 * uiScale) {
            ProviderLogo(provider: profile.provider, size: 28 * uiScale)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2 * uiScale) {
                Text(profile.label).scaledFont(.title3, weight: .semibold)
                Text("\(profile.provider.label) · \(profile.resolvedModel)")
                    .scaledFont(.callout, design: .monospaced).foregroundStyle(.secondary)
            }
            Spacer(minLength: 16 * uiScale)
            EnabledToggle(profile: profile, store: store)
            Button("Edit…", action: edit)
            Menu {
                Button("Delete Worker…", role: .destructive) { confirmingDelete = true }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 24 * uiScale, height: 24 * uiScale)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More actions")
            .accessibilityLabel("More actions")
        }
    }
}

private struct EnvironmentRow: View {
    let key: String
    let value: String
    @State private var revealed = false
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        LabeledContent {
            HStack(spacing: 8 * uiScale) {
                Text(isSecretEnvKey(key) && !revealed ? String(repeating: "•", count: 10) : value)
                    .scaledFont(.body, design: .monospaced)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if isSecretEnvKey(key) {
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
        .padding(.vertical, 8 * uiScale)
    }
}

private struct WorkerRow: View {
    let profile: Profile
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            ProviderLogo(provider: profile.provider, size: 15 * uiScale)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.label).scaledFont(.callout).lineLimit(1)
                Text(profile.resolvedModel).scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if !profile.enabled {
                Text("Off").scaledFont(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 5)
        .opacity(profile.enabled ? 1 : 0.5)
    }
}

private struct MemoryProjectRow: View {
    let project: MemoryProjectSnapshot
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "folder")
                .font(.system(size: 13 * uiScale))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).scaledFont(.callout).lineLimit(1)
                Text("\(project.count) memor\(project.count == 1 ? "y" : "ies")")
                    .scaledFont(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 5)
    }
}

private struct EnabledToggle: View {
    let profile: Profile
    let store: ProfileStore
    @State private var saveFailed = false
    // Mirrors the intended value until the ~2s poll confirms it, so the toggle
    // does not snap back while the save is in flight.
    @State private var pendingEnabled: Bool?

    var body: some View {
        Toggle("Enabled", isOn: Binding(
            get: { pendingEnabled ?? profile.enabled },
            set: { value in
                pendingEnabled = value
                var changed = profile
                changed.enabled = value
                Task {
                    do { try await store.save(changed, isNew: false) } catch {
                        pendingEnabled = nil
                        saveFailed = true
                    }
                }
            }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
        .accessibilityLabel("Enabled")
        .help(profile.enabled ? "Accepts delegated tasks" : "Doesn't accept delegated tasks")
        // The poll caught up — the mirror can drop.
        .onChange(of: profile.enabled) { _, newValue in
            if newValue == pendingEnabled { pendingEnabled = nil }
        }
        .alert("Couldn’t change worker state. Try again.", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        }
    }
}
