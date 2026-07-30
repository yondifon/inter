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
    @Environment(\.uiScale) private var uiScale

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
            .frame(maxWidth: 980 * uiScale)
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)

            ScrollView {
                sectionContent
                    .frame(maxWidth: 980 * uiScale)
                    .padding(24)
                    .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.never)
            .id("\(task.id)-\(section.rawValue)")
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: task.id) {
            resetEventState()
            while !Task.isCancelled {
                await loadEvents()
                let live = store.tasks.first { $0.id == task.id }?.state ?? task.state
                if TaskState(live).isTerminal, !loading { break }
                if loadFailed { try? await Task.sleep(for: .seconds(1)) }
                else if eventCursor == 0 { try? await Task.sleep(for: .milliseconds(500)) }
            }
        }
    }

    @ViewBuilder private var sectionContent: some View {
        switch section {
        case .request:
            TaskPanel { ReviewContentView(source: task.prompt) }
        case .response:
            if let error = task.error {
                TaskPanel(accent: .red) { ReviewContentView(source: error) }
            } else if !task.output.isEmpty {
                TaskPanel { ReviewContentView(source: task.output) }
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
                TaskPanel { eventContent }
                Text("Local trace may contain prompts, tool arguments, file paths, and command output.")
                    .scaledFont(.caption).foregroundStyle(.tertiary)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        StateMarker(state: state)
                        Text(state.label.uppercased())
                            .scaledFont(.caption2, weight: .semibold, design: .monospaced)
                            .tracking(0.6)
                            .foregroundStyle(.secondary)
                    }
                    Text(task.prompt.components(separatedBy: .newlines).first ?? "Task")
                        .scaledFont(.title2, weight: .semibold)
                        .lineLimit(2)
                }
                Spacer()
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: task.cwd))
                } label: {
                    Label("Open folder", systemImage: "folder")
                }
            }
            HStack(spacing: 14) {
                MetadataLabel(icon: "person.crop.circle", text: workerLabel)
                MetadataLabel(icon: "cpu", text: task.model)
                MetadataLabel(icon: "number", text: String(task.id.prefix(8)))
                Spacer()
                Text(task.cwd).scaledFont(.caption, design: .monospaced).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                CopyIconButton(text: task.cwd, label: "Copy folder path")
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
                .scaledFont(.body).foregroundStyle(.secondary).frame(minHeight: 56)
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
                    .scaledFont(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 34 * uiScale)
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

    private var state: TaskState { TaskState(task.state) }

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
                Text("Worker needs input").scaledFont(.callout, weight: .semibold)
                Text(question).scaledFont(.callout).textSelection(.enabled)
                Text("Reply from the agent that started this task.")
                    .scaledFont(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            CopyIconButton(text: question, label: "Copy question")
        }
        .padding(12)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.small))
    }
}

/// Neutral surface for section content. The segmented picker above already names
/// the section, so the panel carries no title of its own.
private struct TaskPanel<Content: View>: View {
    var accent: Color?
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(
                accent?.opacity(0.08) ?? Surface.panel,
                in: RoundedRectangle(cornerRadius: Radius.medium)
            )
    }
}

private struct TaskEventRow: View {
    let event: TaskEventSnapshot
    let showLine: Bool
    @State private var showingRawDetails = false

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: icon).scaledFont(.caption, weight: .semibold)
                    .foregroundStyle(tint)
                    .frame(width: 22 * uiScale, height: 22 * uiScale)
                    .background(rail, in: Circle())
                    .accessibilityHidden(true)
                if showLine {
                    Rectangle().fill(Color(nsColor: .separatorColor))
                        .frame(width: 1).frame(minHeight: 20 * uiScale)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(event.title).scaledFont(.callout, weight: .medium, design: .monospaced)
                    Text(event.source).scaledFont(.caption2, design: .monospaced).foregroundStyle(.tertiary)
                    if event.rawText != nil {
                        IconButton(
                            symbol: showingRawDetails ? "chevron.down" : "chevron.right",
                            label: showingRawDetails ? "Hide raw details" : "Show raw details",
                            tint: AnyShapeStyle(.tertiary)
                        ) { showingRawDetails.toggle() }
                        .scaledFont(.caption2, weight: .semibold)
                    }
                    Spacer()
                    Text(timeLabel).scaledFont(.caption2, design: .monospaced).foregroundStyle(.tertiary)
                        .help(event.createdAt)
                }
                if let presentation = event.presentation {
                    TaskEventPresentationView(presentation: presentation)
                } else if let detail = event.detail {
                    Text(detail)
                        .scaledFont(.caption, design: isCode ? .monospaced : .default)
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

    private var isCode: Bool {
        event.kind == "command" || event.kind == "file"
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

    /// Color earns its place only when a run failed. Everything else reads neutral
    /// so a long trace stays scannable.
    private var tint: Color {
        event.phase == "failed" ? .red : .secondary
    }

    private var rail: Color {
        event.phase == "failed"
            ? Color.red.opacity(0.12)
            : Color(nsColor: .separatorColor).opacity(0.35)
    }
}

private struct TaskEventPresentationView: View {
    let presentation: TaskEventPresentationSnapshot

    @Environment(\.uiScale) private var uiScale

    @ViewBuilder var body: some View {
        switch presentation.type {
        case "file":
            HStack(spacing: 8) {
                if let path = presentation.path {
                    Text(path).scaledFont(.caption, design: .monospaced).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                if let change = presentation.change {
                    Text(change).scaledFont(.caption, weight: .medium, design: .monospaced)
                        .lineLimit(1)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
                }
            }
            .textSelection(.enabled)
        case "command":
            VStack(alignment: .leading, spacing: 3) {
                Text(presentation.command ?? "Command")
                    .scaledFont(.caption, design: .monospaced)
                    .lineLimit(2)
                    .textSelection(.enabled)
                if presentation.status != nil || presentation.exitCode != nil {
                    Text(commandStatus).scaledFont(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 7).padding(.vertical, 5)
            .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
        case "message":
            Text(presentation.text ?? "")
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .textSelection(.enabled)
        case "tool":
            Text(presentation.text ?? "")
                .scaledFont(.caption, design: .monospaced)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .textSelection(.enabled)
        case "todo":
            HStack(spacing: 8) {
                ProgressView(
                    value: Double(presentation.completed ?? 0),
                    total: Double(max(presentation.total ?? 0, 1))
                )
                .frame(width: 72 * uiScale)
                Text("\(presentation.completed ?? 0) of \(presentation.total ?? 0) complete")
                    .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.secondary)
                if let active = presentation.text {
                    Text(active).scaledFont(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
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

private struct MetadataLabel: View {
    let icon: String
    let text: String
    var body: some View {
        Label(text, systemImage: icon)
            .scaledFont(.caption, design: .monospaced)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}
