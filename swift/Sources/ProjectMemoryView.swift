import Foundation
import SwiftUI

/// What a project remembers, read-only. Memories are written by agents through
/// the MCP tool; this is the only place a person can see what those agents will
/// be told about a folder.
struct ProjectMemoryView: View {
    let project: MemoryProjectSnapshot
    let store: ProfileStore

    @State private var memories: [MemorySnapshot] = []
    @State private var loaded = false
    @State private var selection: MemorySnapshot.ID?
    @State private var order = [KeyPathComparator(\MemorySnapshot.key)]
    @State private var query = ""
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if memories.isEmpty, !loaded {
                HStack { ProgressView().controlSize(.small); Text("Loading memories…").foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if memories.isEmpty {
                ContentUnavailableView(
                    "No memories",
                    systemImage: "brain",
                    description: Text("Nothing has been stored for this project yet.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if visible.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                table
                if let selected { valuePanel(selected) }
            }
        }
        .frame(maxWidth: 980 * uiScale, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.content)
        .searchable(text: $query, prompt: "Filter memories")
        .task(id: project.cwd) {
            loaded = false
            selection = nil
            memories = await store.memories(cwd: project.cwd)
            loaded = true
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(project.name).scaledFont(.title3, weight: .semibold)
                Text("\(project.count) memor\(project.count == 1 ? "y" : "ies")")
                    .scaledFont(.callout).foregroundStyle(.secondary)
                Spacer(minLength: 8)
            }
            HStack(spacing: 8) {
                Text(project.cwd)
                    .scaledFont(.callout, design: .monospaced)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
                CopyIconButton(text: project.cwd, label: "Copy path")
                Spacer(minLength: 8)
            }
        }
    }

    /// Values are up to 16,000 characters, so the table shows one truncated line
    /// and the row that is selected opens in full underneath it.
    private var table: some View {
        Table(visible, selection: $selection, sortOrder: $order) {
            TableColumn("Key", value: \.key) { memory in
                Text(memory.key).scaledFont(.callout, design: .monospaced).lineLimit(1)
            }
            .width(min: 140 * uiScale, ideal: 220 * uiScale)
            TableColumn("Value", value: \.value) { memory in
                Text(memory.value).scaledFont(.callout).lineLimit(1).truncationMode(.tail)
            }
            TableColumn("Updated", value: \.updatedAt) { memory in
                Text(updated(memory.updatedAt)).scaledFont(.callout).foregroundStyle(.secondary)
            }
            .width(min: 110 * uiScale, ideal: 150 * uiScale)
            TableColumn("Version", value: \.version) { memory in
                Text("\(memory.version)")
                    .scaledFont(.callout, design: .monospaced, monospacedDigit: true)
                    .foregroundStyle(.secondary)
            }
            .width(min: 60 * uiScale, ideal: 70 * uiScale)
        }
        .scrollIndicators(.never)
    }

    private func valuePanel(_ memory: MemorySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(memory.key).scaledFont(.callout, weight: .semibold, design: .monospaced)
                Spacer(minLength: 8)
                Text("v\(memory.version) · \(updated(memory.updatedAt))")
                    .scaledFont(.caption).foregroundStyle(.secondary)
                CopyIconButton(text: memory.value, label: "Copy value")
            }
            ScrollView {
                Text(memory.value)
                    .scaledFont(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.never)
            .frame(maxHeight: 240 * uiScale)
        }
        .padding(16)
        .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
    }

    private var visible: [MemorySnapshot] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let matching = trimmed.isEmpty ? memories : memories.filter {
            $0.key.localizedCaseInsensitiveContains(trimmed)
                || $0.value.localizedCaseInsensitiveContains(trimmed)
        }
        return matching.sorted(using: order)
    }

    private var selected: MemorySnapshot? {
        visible.first { $0.id == selection }
    }

    /// A memory is edited across days, so a wall-clock time alone would not say
    /// which one.
    private func updated(_ value: String) -> String {
        guard let date = EventClock.date(value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
