import AppKit
import Foundation
import SwiftUI

enum TaskDetailSection: String, CaseIterable, Identifiable {
    case request
    case response
    case activity

    var id: Self { self }

    static func initial(for task: TaskSnapshot) -> Self {
        switch task.state {
        case "queued", "running":
            return .activity
        default:
            return task.output.isEmpty && task.error == nil ? .activity : .response
        }
    }
}

struct TaskDetail: View {
    let task: TaskSnapshot
    let store: ProfileStore
    @State private var section: TaskDetailSection
    @State private var events: [TaskEventSnapshot] = []
    @State private var eventCursor = 0
    @State private var loadedInitialEvents = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showingTechnicalEvents = false

    init(task: TaskSnapshot, store: ProfileStore) {
        self.task = task
        self.store = store
        _section = State(initialValue: TaskDetailSection.initial(for: task))
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                header
                if task.state == "needs_input", let question = task.question {
                    NeedsInputBanner(question: question)
                }
                Picker("Task content", selection: $section) {
                    Text("Request").tag(TaskDetailSection.request)
                    Text(task.error == nil ? "Response" : "Error").tag(TaskDetailSection.response)
                    Text("Activity").tag(TaskDetailSection.activity)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .frame(maxWidth: 980)
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)

            Divider()

            ScrollView {
                sectionContent
                    .frame(maxWidth: 980)
                    .padding(24)
                    .frame(maxWidth: .infinity)
            }
            .id("\(task.id)-\(section.rawValue)")
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: task.id) {
            resetEventState()
            while !Task.isCancelled {
                await loadEvents()
                let state = store.tasks.first { $0.id == task.id }?.state ?? task.state
                if ["completed", "failed", "needs_input"].contains(state), !loading { break }
                if loadFailed { try? await Task.sleep(for: .seconds(1)) }
                else if eventCursor == 0 { try? await Task.sleep(for: .milliseconds(500)) }
            }
        }
    }

    @ViewBuilder private var sectionContent: some View {
        switch section {
        case .request:
            TaskPanel(title: "Request", icon: "arrow.up.message") {
                ReviewContentView(source: task.prompt)
            }
        case .response:
            if let error = task.error {
                TaskPanel(title: "Error", icon: "exclamationmark.triangle") {
                    ReviewContentView(source: error)
                }
            } else if !task.output.isEmpty {
                TaskPanel(title: "Response", icon: "text.bubble") {
                    ReviewContentView(source: task.output)
                }
            } else {
                ContentUnavailableView(
                    "No response yet",
                    systemImage: "text.bubble",
                    description: Text("The worker’s response will appear here.")
                )
                .frame(maxWidth: .infinity, minHeight: 220)
            }
        case .activity:
            VStack(alignment: .leading, spacing: 12) {
                TaskPanel(title: "Activity", icon: "point.3.filled.connected.trianglepath.dotted") {
                    eventContent
                }
                Text("Local trace may contain prompts, tool arguments, file paths, and command output.")
                    .font(.caption).foregroundStyle(.tertiary)
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
                ForEach(Array(visibleEvents.enumerated()), id: \.element.id) { index, event in
                    TaskEventRow(event: event, showLine: index < visibleEvents.count - 1)
                }
                if technicalEventCount > 0 {
                    Button(showingTechnicalEvents
                           ? "Hide technical events"
                           : "Show \(technicalEventCount) technical events") {
                        showingTechnicalEvents.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 36)
                    .padding(.top, 6)
                }
            }
        }
    }

    private var visibleEvents: [TaskEventSnapshot] {
        showingTechnicalEvents ? events : events.filter { !$0.isTechnicalNoise }
    }

    private var technicalEventCount: Int {
        events.count - events.filter { !$0.isTechnicalNoise }.count
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
                guard !Task.isCancelled else { return }
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

    private func resetEventState() {
        events = []
        eventCursor = 0
        loadedInitialEvents = false
        loading = true
        loadFailed = false
        showingTechnicalEvents = false
    }

    private func appendEvents(_ incoming: [TaskEventSnapshot]) {
        var known = Set(events.map(\.id))
        events.append(contentsOf: incoming.filter { known.insert($0.id).inserted })
        events.sort { $0.id < $1.id }
    }
}

private struct NeedsInputBanner: View {
    let question: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "questionmark.bubble.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("Worker needs input").font(.callout.weight(.semibold))
                Text(question).font(.callout).textSelection(.enabled)
                Text("Reply from the agent that started this task.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            TaskCopyButton(text: question)
        }
        .padding(12)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
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
    @State private var showingRawDetails = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: icon).font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                    .frame(width: 24, height: 24)
                    .background(color.opacity(0.12), in: Circle())
                if showLine {
                    Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1).frame(minHeight: 22)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(event.title).font(.callout.weight(.medium))
                    Text(event.source).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    if event.rawText != nil {
                        Button {
                            showingRawDetails.toggle()
                        } label: {
                            Image(systemName: showingRawDetails ? "chevron.down" : "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .frame(width: 18, height: 18)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tertiary)
                        .help(showingRawDetails ? "Hide raw details" : "Show raw details")
                        .accessibilityLabel(showingRawDetails ? "Hide raw details" : "Show raw details")
                    }
                    Spacer()
                    Text(timeLabel).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                        .help(event.createdAt)
                }
                if let presentation = event.presentation {
                    TaskEventPresentationView(presentation: presentation)
                } else if let detail = event.detail {
                    Text(detail).font(event.kind == "command" || event.kind == "file" ? .caption.monospaced() : .caption)
                        .foregroundStyle(.secondary).textSelection(.enabled)
                        .lineLimit(event.kind == "file" ? 1 : 6)
                }
                if showingRawDetails, let raw = event.rawText {
                    ReviewContentView(source: raw, initiallyExpandJSON: false)
                        .padding(.top, 5)
                }
            }
            .padding(.bottom, showLine ? 8 : 0)
        }
    }

    private var timeLabel: String {
        TaskEventTime.format(event.createdAt)
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

private struct TaskEventPresentationView: View {
    let presentation: TaskEventPresentationSnapshot

    @ViewBuilder var body: some View {
        switch presentation.type {
        case "file":
            HStack(spacing: 8) {
                if let path = presentation.path {
                    Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                if let change = presentation.change {
                    Text(change).font(.caption.monospaced().weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(nsColor: .textBackgroundColor),
                                    in: RoundedRectangle(cornerRadius: 4))
                }
            }
            .textSelection(.enabled)
        case "command":
            VStack(alignment: .leading, spacing: 3) {
                Text(presentation.command ?? "Command")
                    .font(.caption.monospaced())
                    .lineLimit(2)
                    .textSelection(.enabled)
                if presentation.status != nil || presentation.exitCode != nil {
                    Text(commandStatus).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 7).padding(.vertical, 5)
            .background(Color(nsColor: .textBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 5))
        case "message":
            Text(presentation.text ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .textSelection(.enabled)
        case "todo":
            HStack(spacing: 8) {
                ProgressView(
                    value: Double(presentation.completed ?? 0),
                    total: Double(max(presentation.total ?? 0, 1))
                )
                .frame(width: 72)
                Text("\(presentation.completed ?? 0) of \(presentation.total ?? 0) complete")
                    .font(.caption).foregroundStyle(.secondary)
            }
        default:
            EmptyView()
        }
    }

    private var commandStatus: String {
        [
            presentation.status,
            presentation.exitCode.map { "exit \($0)" },
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }
}

extension TaskEventSnapshot {
    var isTechnicalNoise: Bool {
        if kind == "raw", ["Step Start", "Step Finish"].contains(title) {
            return true
        }
        return title == "Heartbeat" && !(detail?.contains("No agent event") ?? false)
    }
}

private enum TaskEventTime {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()

    static func format(_ value: String) -> String {
        guard let date = fractional.date(from: value) ?? standard.date(from: value) else {
            return value
        }
        return date.formatted(date: .omitted, time: .standard)
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
