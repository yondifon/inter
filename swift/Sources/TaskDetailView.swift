import AppKit
import SwiftUI

struct TaskDetail: View {
    let task: TaskSnapshot
    let store: ProfileStore
    @State private var events: [TaskEventSnapshot] = []
    @State private var eventCursor = 0
    @State private var loadedInitialEvents = false
    @State private var loading = true
    @State private var loadFailed = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                header
                if !task.output.isEmpty || task.error != nil {
                    TaskPanel(title: task.error == nil ? "Response" : "Error",
                              icon: task.error == nil ? "text.bubble" : "exclamationmark.triangle") {
                        ReviewContentView(source: task.error ?? task.output)
                    }
                }
                TaskPanel(title: "Request", icon: "arrow.up.message") {
                    ReviewContentView(source: task.prompt)
                }
                TaskPanel(title: "Activity", icon: "point.3.filled.connected.trianglepath.dotted") {
                    eventContent
                }
                Text("Local trace may contain prompts, tool arguments, file paths, and command output.")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: 980)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: task.id) {
            while !Task.isCancelled {
                await loadEvents()
                let state = store.tasks.first { $0.id == task.id }?.state ?? task.state
                if ["completed", "failed"].contains(state), !loading { break }
                if loadFailed { try? await Task.sleep(for: .seconds(1)) }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Circle().fill(stateColor).frame(width: 8, height: 8)
                        Text(task.state.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption.weight(.semibold))
                    }
                    Text(task.prompt.components(separatedBy: .newlines).first ?? "Task")
                        .font(.title2.weight(.semibold))
                        .lineLimit(2)
                }
                Spacer()
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: task.cwd))
                } label: {
                    Label("Open folder", systemImage: "folder")
                }
            }
            HStack(spacing: 8) {
                MetadataChip(icon: "person.crop.circle", text: workerLabel)
                MetadataChip(icon: "cpu", text: task.model)
                MetadataChip(icon: "number", text: String(task.id.prefix(8)))
                Spacer()
                Text(task.cwd).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                TaskCopyButton(text: task.cwd)
            }
        }
    }

    @ViewBuilder private var eventContent: some View {
        if loading {
            HStack { ProgressView().controlSize(.small); Text("Loading trace…").foregroundStyle(.secondary) }
                .frame(minHeight: 56)
        } else if loadFailed {
            HStack {
                Label("Couldn’t load activity.", systemImage: "exclamationmark.triangle")
                Spacer()
                Button("Retry") { Task { await loadEvents() } }
            }.frame(minHeight: 56)
        } else if events.isEmpty {
            Text("No structured events for this run. New delegated runs stream activity here.")
                .foregroundStyle(.secondary).frame(minHeight: 56)
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    TaskEventRow(event: event, showLine: index < events.count - 1)
                }
            }
        }
    }

    private var workerLabel: String {
        store.profiles.first { $0.id == task.profileId }?.label ?? task.profileId
    }

    private var stateColor: Color {
        switch task.state {
        case "completed": .green
        case "failed": .red
        case "needs_input": .orange
        default: .blue
        }
    }

    private func loadEvents() async {
        do {
            var hasMore = true
            while hasMore, !Task.isCancelled {
                var components = URLComponents(
                    url: InterServer.api("tasks/\(task.id)/events"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [
                    URLQueryItem(name: "after", value: String(eventCursor)),
                    URLQueryItem(name: "waitMs", value: loadedInitialEvents ? "25000" : "0"),
                ]
                let (data, response) = try await URLSession.shared.data(from: components.url!)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    loadFailed = true; loading = false; return
                }
                if let page = try? JSONDecoder().decode(TaskEventPage.self, from: data) {
                    appendEvents(page.events)
                    eventCursor = max(eventCursor, page.cursor)
                    hasMore = page.hasMore
                    loadedInitialEvents = true
                } else {
                    let initial = try JSONDecoder().decode([TaskEventSnapshot].self, from: data)
                    appendEvents(initial)
                    eventCursor = max(eventCursor, initial.map(\.id).max() ?? 0)
                    hasMore = false
                    loadedInitialEvents = true
                }
            }
            loadFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            loadFailed = true
        }
        loading = false
    }

    private func appendEvents(_ incoming: [TaskEventSnapshot]) {
        var known = Set(events.map(\.id))
        events.append(contentsOf: incoming.filter { known.insert($0.id).inserted })
        events.sort { $0.id < $1.id }
    }
}

private struct TaskPanel<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon).font(.headline)
            content
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(nsColor: .separatorColor)))
    }
}

private struct TaskEventRow: View {
    let event: TaskEventSnapshot
    let showLine: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: icon).font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                    .frame(width: 24, height: 24)
                    .background(color.opacity(0.12), in: Circle())
                if showLine {
                    Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1).frame(minHeight: 30)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(event.title).font(.callout.weight(.medium))
                    Text(event.source).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    Spacer()
                    Text(event.createdAt).font(.caption2).foregroundStyle(.tertiary)
                }
                if let detail = event.detail {
                    Text(detail).font(event.kind == "command" || event.kind == "file" ? .caption.monospaced() : .caption)
                        .foregroundStyle(.secondary).textSelection(.enabled).lineLimit(6)
                }
                if let raw = event.rawText {
                    DisclosureGroup("Details") {
                        ReviewContentView(source: raw)
                            .padding(.top, 6)
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.bottom, showLine ? 12 : 0)
        }
    }

    private var icon: String {
        switch event.kind {
        case "message": "text.bubble"
        case "reasoning": "brain"
        case "tool": "wrench.and.screwdriver"
        case "command": "terminal"
        case "file": "doc"
        case "error": "exclamationmark.triangle"
        case "usage": "gauge"
        case "lifecycle": event.phase == "completed" ? "checkmark" : "circle"
        default: "ellipsis"
        }
    }

    private var color: Color {
        switch event.phase {
        case "completed": .green
        case "failed": .red
        case "started": .blue
        default: .secondary
        }
    }
}

private struct MetadataChip: View {
    let icon: String
    let text: String
    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct TaskCopyButton: View {
    let text: String
    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } label: {
            Image(systemName: "doc.on.doc")
        }
        .buttonStyle(.plain).help("Copy path")
    }
}
