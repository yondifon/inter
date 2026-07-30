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
                eventContent
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
            TaskPanel {
                HStack { ProgressView().controlSize(.small); Text("Loading trace…").foregroundStyle(.secondary) }
                    .frame(minHeight: 56)
            }
        } else if loadFailed {
            TaskPanel {
                HStack {
                    Label("Couldn’t load activity.", systemImage: "exclamationmark.triangle")
                    Spacer()
                    Button("Retry") { Task { await loadEvents() } }
                }.frame(minHeight: 56)
            }
        } else if events.isEmpty {
            TaskPanel {
                Text("No structured events for this run. New delegated runs stream activity here.")
                    .scaledFont(.body).foregroundStyle(.secondary).frame(minHeight: 56)
            }
        } else {
            let story = ActivityStory.compose(events)
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(story.blocks) { block in
                    ActivityBlockView(block: block)
                }
                if showingTechnicalEvents, !story.technical.isEmpty {
                    ActivityChapterCard(events: story.technical, muted: true)
                }
                if !story.technical.isEmpty {
                    Button(showingTechnicalEvents
                           ? "Hide technical events"
                           : "Show \(story.technical.count) technical events") {
                        showingTechnicalEvents.toggle()
                    }
                    .buttonStyle(.plain)
                    .scaledFont(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }
            }
        }
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

private struct ActivityBlockView: View {
    let block: ActivityBlock

    var body: some View {
        switch block {
        case .chapter(_, let events):
            ActivityChapterCard(events: events, muted: false)
        case .reasoning(let pulse):
            ActivityReasoningRow(pulse: pulse)
        case .signal(let event):
            ActivitySignalCard(event: event)
        case .receipt(let event):
            ActivityReceiptCard(event: event)
        }
    }
}

/// A run of consecutive work events on one flat card: no rails, no dots. Each
/// row leads with what happened; the clock stays out of the way on the right.
struct ActivityChapterCard: View {
    let events: [TaskEventSnapshot]
    var muted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                ActivityWorkRow(event: event, muted: muted)
                if index < events.count - 1 {
                    Divider().opacity(0.4)
                }
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
        .opacity(muted ? 0.72 : 1)
    }
}

private struct ActivityWorkRow: View {
    let event: TaskEventSnapshot
    var muted = false
    @State private var showingRawDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if isQuote {
                    quoteContent
                } else {
                    Text(event.title)
                        .scaledFont(.callout, weight: .medium, design: .monospaced)
                        .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                        .layoutPriority(1)
                    inlineContent
                }
                Spacer(minLength: 12)
                if event.rawText != nil {
                    IconButton(
                        symbol: showingRawDetails ? "chevron.down" : "chevron.right",
                        label: showingRawDetails ? "Hide raw details" : "Show raw details",
                        tint: AnyShapeStyle(.tertiary)
                    ) { showingRawDetails.toggle() }
                    .scaledFont(.caption2, weight: .semibold)
                }
                Text(EventClock.time(event.createdAt))
                    .scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary)
                    .help(event.createdAt)
            }
            if let presentation = blockPresentation {
                TaskEventPresentationView(presentation: presentation)
            }
            if showingRawDetails, let raw = event.rawText {
                ReviewContentView(source: raw, initiallyExpandJSON: false)
                    .padding(.top, 3)
            }
        }
        .padding(.vertical, 8)
    }

    /// Agent prose reads as a quotation, not as a titled row.
    private var isQuote: Bool {
        event.kind == "message" || (event.kind == "reasoning" && event.title != "Thinking")
    }

    @ViewBuilder private var quoteContent: some View {
        HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color(nsColor: .separatorColor))
                .frame(width: 2)
            Text(event.presentation?.text ?? event.detail ?? event.title)
                .scaledFont(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(6)
                .textSelection(.enabled)
        }
    }

    /// Compact one-line details stay on the title line; anything taller drops
    /// below it. Usage and signal shapes render in their own cards, so a stray
    /// one here (a superseded turn receipt in the technical list) shows its
    /// plain detail text instead of nothing.
    private var blockPresentation: TaskEventPresentationSnapshot? {
        guard !isQuote, let presentation = event.presentation else {
            return isQuote ? nil : fallbackDetail
        }
        switch presentation.type {
        case "file":
            return nil
        case "usage", "signal":
            guard let detail = event.detail else { return nil }
            return TaskEventPresentationSnapshot(type: "message", text: detail)
        default:
            return presentation
        }
    }

    private var fallbackDetail: TaskEventPresentationSnapshot? {
        guard event.presentation == nil, let detail = event.detail else { return nil }
        return TaskEventPresentationSnapshot(type: "message", text: detail)
    }

    @ViewBuilder private var inlineContent: some View {
        if let presentation = event.presentation, presentation.type == "file" {
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
        }
    }
}

/// Thinking bursts become one quiet line between chapters instead of a row
/// per counter tick.
private struct ActivityReasoningRow: View {
    let pulse: ActivityStory.ReasoningPulse

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "brain").scaledFont(.caption2).foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            Text(label).scaledFont(.caption, design: .monospaced).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
    }

    private var label: String {
        var parts = [pulse.detail.replacingOccurrences(of: "~", with: "Reasoned ~")]
        if let seconds = pulse.seconds { parts.append("\(seconds)s") }
        return parts.joined(separator: " · ")
    }
}

/// Retries, rate limits, stalls, questions, and broker failures get one loud
/// strip each. This is the only place the trace uses color before failure.
private struct ActivitySignalCard: View {
    let event: TaskEventSnapshot

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: symbol).scaledFont(.caption, weight: .semibold)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).scaledFont(.callout, weight: .medium)
                if let text = event.presentation?.text ?? event.detail {
                    Text(text).scaledFont(.caption).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 12)
            Text(EventClock.time(event.createdAt))
                .scaledFont(.caption2, design: .monospaced)
                .foregroundStyle(.tertiary)
                .help(event.createdAt)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: Radius.medium))
    }

    private var severity: String {
        if event.kind == "error" { return "error" }
        return event.presentation?.level ?? "warning"
    }

    private var tint: Color {
        switch severity {
        case "error": .red
        case "info": .secondary
        default: .orange
        }
    }

    private var symbol: String {
        switch event.title {
        case "Worker needs input": "questionmark.bubble"
        case "Rate limit": "hourglass"
        case "API retry": "arrow.clockwise"
        case "Heartbeat": "zzz"
        default: "exclamationmark.triangle"
        }
    }
}

/// The run's settlement: cost, turns, duration, and tokens as stats instead of
/// a JSON blob. Denials surface here because this is where they were buried.
private struct ActivityReceiptCard: View {
    let event: TaskEventSnapshot
    @State private var showingRawDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(event.phase == "failed" ? "Run failed" : "Run settled")
                    .scaledFont(.caption, weight: .semibold, design: .monospaced)
                    .tracking(0.5)
                    .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    .textCase(.uppercase)
                Spacer()
                if event.rawText != nil {
                    IconButton(
                        symbol: showingRawDetails ? "chevron.down" : "chevron.right",
                        label: showingRawDetails ? "Hide raw details" : "Show raw details",
                        tint: AnyShapeStyle(.tertiary)
                    ) { showingRawDetails.toggle() }
                    .scaledFont(.caption2, weight: .semibold)
                }
                Text(EventClock.time(event.createdAt))
                    .scaledFont(.caption2, design: .monospaced).foregroundStyle(.tertiary)
            }
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(stats.enumerated()), id: \.offset) { index, stat in
                    if index > 0 { Divider().frame(maxHeight: 34).padding(.horizontal, 14) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stat.value)
                            .scaledFont(.title3, weight: .semibold, monospacedDigit: true)
                        Text(stat.label)
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if let warning = event.presentation?.text {
                Label(warning, systemImage: "hand.raised")
                    .scaledFont(.caption, weight: .medium)
                    .foregroundStyle(.orange)
            }
            if showingRawDetails, let raw = event.rawText {
                ReviewContentView(source: raw, initiallyExpandJSON: false)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.medium)
                .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
        )
    }

    private var stats: [(value: String, label: String)] {
        guard let presentation = event.presentation else {
            return [(event.detail ?? "—", "summary")]
        }
        var values: [(String, String)] = []
        if let cost = presentation.costUsd { values.append((ActivityFormat.cost(cost), "cost")) }
        if let turns = presentation.turns { values.append((String(turns), turns == 1 ? "turn" : "turns")) }
        if let duration = presentation.durationMs { values.append((ActivityFormat.duration(duration), "duration")) }
        if let out = presentation.tokensOut { values.append((ActivityFormat.count(out), "tokens out")) }
        if let input = presentation.tokensIn { values.append((ActivityFormat.count(input), "tokens in")) }
        if let cached = presentation.tokensCached { values.append((ActivityFormat.count(cached), "cached")) }
        return values.isEmpty ? [(event.detail ?? "—", "summary")] : Array(values.prefix(5))
    }
}

struct TaskEventPresentationView: View {
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
