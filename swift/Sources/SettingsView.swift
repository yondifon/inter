import SwiftUI

/// Standard Settings window content, opened by ⌘, (see `AppDelegate.openSettings`
/// in main.swift — this app is AppKit-lifecycle, not a SwiftUI `App`, so there is
/// no `Settings` scene to host this for free). Workers is the only pane today; a
/// second pane would make this worth wrapping in a `TabView`.
struct SettingsView: View {
    let store: ProfileStore
    @State private var selection: String?
    @State private var editing: Profile?
    @State private var adding = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                if store.profiles.isEmpty {
                    Text("No workers yet. Add one to start delegating.")
                        .scaledFont(.callout).foregroundStyle(.tertiary)
                } else {
                    ForEach(store.profiles) { profile in
                        WorkerRow(profile: profile).tag(profile.id)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollIndicators(.never)
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
            .toolbar {
                ToolbarItem {
                    Button("Add Worker", systemImage: "plus") { adding = true }
                        .help("Add worker")
                }
            }
        } detail: {
            if let id = selection, let profile = store.profiles.first(where: { $0.id == id }) {
                ProfileDetail(profile: profile, store: store) { editing = profile }
                    .id(profile.id)
            } else {
                ContentUnavailableView("Choose a worker", systemImage: "person.2")
            }
        }
        .sheet(isPresented: $adding) { ProfileFormView(store: store) }
        .sheet(item: $editing) { ProfileFormView(store: store, profile: $0) }
        // A worker deleted from the detail pane leaves `selection` pointing at a
        // profile that no longer exists; fall back to the empty state instead of
        // stranding the detail pane on stale data.
        .onChange(of: store.profiles) { _, profiles in
            if let selection, !profiles.contains(where: { $0.id == selection }) {
                self.selection = nil
            }
        }
        .frame(minWidth: 640, minHeight: 420)
        .navigationTitle("Settings")
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
                        Text("\(profile.provider.label) · \(profile.resolvedModel)")
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
        HStack(spacing: 9) {
            ProviderLogo(provider: profile.provider, size: 15 * uiScale)
                .accessibilityHidden(true)
                .frame(width: 18 * uiScale, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.label).scaledFont(.body).lineLimit(1)
                Text(profile.resolvedModel).scaledFont(.caption, design: .monospaced)
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

private struct EnabledToggle: View {
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
