import SwiftUI

struct EnvRow: Identifiable {
    let id = UUID()
    var key: String
    var value: String
}

struct ProfileFormView: View {
    @Environment(\.dismiss) private var dismiss
    let store: ProfileStore
    let original: Profile?
    @State private var profile: Profile
    @State private var envRows: [EnvRow]
    @State private var saveError: String?

    init(store: ProfileStore, profile: Profile? = nil) {
        self.store = store
        self.original = profile
        _profile = State(initialValue: profile ?? .empty)
        _envRows = State(initialValue: (profile?.env ?? [:]).sorted { $0.key < $1.key }
            .map { EnvRow(key: $0.key, value: $0.value) })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(original == nil ? "Add worker" : "Edit worker").font(.title3.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { save() }.buttonStyle(.borderedProminent).disabled(!valid)
            }
            .padding(20)

            Form {
                Section("Worker") {
                    TextField("Name", text: $profile.label)
                    Picker("CLI", selection: $profile.provider) {
                        ForEach(Provider.allCases) { Text($0.label).tag($0) }
                    }
                    TextField("Model", text: $profile.model)
                    Toggle("Enabled", isOn: $profile.enabled).toggleStyle(.switch)
                }
                Section {
                    ForEach($envRows) { $row in
                        HStack {
                            TextField("ENV_NAME", text: $row.key).font(.system(.body, design: .monospaced))
                            TextField("Value or path", text: $row.value).font(.system(.body, design: .monospaced))
                            Button(role: .destructive) {
                                envRows.removeAll { $0.id == row.id }
                            } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.plain)
                        }
                    }
                    Button("Add environment variable", systemImage: "plus") {
                        envRows.append(EnvRow(key: "", value: ""))
                    }
                } header: {
                    Text("Environment")
                } footer: {
                    Text("Use separate config directories for each signed-in account. Example: CLAUDE_CONFIG_DIR = $HOME/.claude-work")
                }
                if let saveError { Text(saveError).foregroundStyle(.red) }
            }
            .formStyle(.grouped)
        }
        .frame(width: 560, height: 540)
    }

    private var valid: Bool {
        let keys = envRows.map { $0.key.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return !profile.label.trimmingCharacters(in: .whitespaces).isEmpty &&
        !profile.model.trimmingCharacters(in: .whitespaces).isEmpty &&
        envRows.allSatisfy { !$0.key.isEmpty || $0.value.isEmpty } &&
        Set(keys).count == keys.count
    }

    private func save() {
        profile.env = Dictionary(uniqueKeysWithValues: envRows
            .filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { ($0.key.trimmingCharacters(in: .whitespaces), $0.value) })
        Task {
            do {
                try await store.save(profile, isNew: original == nil)
                dismiss()
            } catch {
                saveError = "Couldn’t save worker."
            }
        }
    }
}
