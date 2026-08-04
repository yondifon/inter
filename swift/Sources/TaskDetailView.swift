import AppKit
import Foundation
import SwiftUI

enum TaskDetailSection: String, CaseIterable, Identifiable {
    case request
    case response
    case activity

    var id: Self { self }

    /// Three silhouettes that stay apart with no word under them: what was sent,
    /// what came back, what happened. All outline, all the same stroke weight.
    var symbol: String {
        switch self {
        case .request: "paperplane"
        case .response: "text.bubble"
        case .activity: "list.bullet"
        }
    }

    var label: String {
        switch self {
        case .request: "Request"
        case .response: "Response"
        case .activity: "Activity"
        }
    }
}

struct TaskDetail: View {
    let task: TaskSnapshot
    let store: ProfileStore
    let setArchived: (TaskSnapshot, Bool) -> Void
    /// Activity is where a run is read — the response is one tab away, and landing
    /// there mid-run would mean opening on an empty panel.
    @State private var section: TaskDetailSection = .activity
    @State private var events: [TaskEventSnapshot] = []
    /// The retelling of `events`, kept beside them rather than folded in `body`.
    /// Composing is pure but linear in the trace, and a long run re-folded a few
    /// thousand events on every render pass; it only has to change when the
    /// events do.
    @State private var story = ActivityStory.Composition(blocks: [], technical: [])
    @State private var eventCursor = 0
    @State private var loadedInitialEvents = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showingTechnicalEvents = false
    @State private var showingEarlierActivity = false
    @State private var showingRunFacts = false
    @State private var confirmingCancel = false
    @State private var showingResumeSheet = false
    @State private var showingActionError = false
    /// Whether activity opens on its newest event. Fixed when the task opens: a
    /// run that lands while it is being read would otherwise yank the trace back
    /// to the top under the reader.
    @State private var followsTail: Bool
    @Environment(\.uiScale) private var uiScale

    init(task: TaskSnapshot, store: ProfileStore, setArchived: @escaping (TaskSnapshot, Bool) -> Void) {
        self.task = task
        self.store = store
        self.setArchived = setArchived
        // A finished run is read from the beginning; only a live one is read from
        // the end, where the next event will land.
        _followsTail = State(initialValue: !TaskState(task.state).isTerminal)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                if task.state == "needs_input", let question = task.question {
                    NeedsInputBanner(question: question)
                }
                HStack(spacing: 0) {
                    TaskSectionTabs(selection: $section, hasError: task.error != nil)
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: 980 * uiScale)
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        jumpMarker("top")
                        sectionContent
                            .frame(maxWidth: 980 * uiScale)
                            .padding(24)
                            .frame(maxWidth: .infinity)
                        jumpMarker("bottom")
                    }
                }
                // Native scroller behaviour — the indicator surfaces while scrolling
                // and fades when idle, so a long trace gives position feedback
                // without a permanent rail.
                .scrollIndicators(.automatic)
                .id("\(task.id)-\(section.rawValue)")
                // Scrolling to a sentinel at the end of the list put the view past the
                // content whenever the rows under it had not been measured yet — the
                // panel opened blank, and nothing re-clamped it. The anchor asks for
                // the same thing against the real content size, so it cannot overshoot,
                // and it keeps holding the tail as events stream in.
                .defaultScrollAnchor(followsTail && section == .activity ? .bottom : .top)
                .overlay(alignment: .bottomTrailing) {
                    ScrollJumpControl(proxy: proxy)
                        .padding(.trailing, 16 * uiScale)
                        .padding(.bottom, 16 * uiScale)
                }
            }
        }
        .background(Surface.content)
        .task(id: task.id) {
            resetEventState()
            while !Task.isCancelled {
                await loadEvents()
                if TaskState(liveState).isTerminal {
                    // A settled run is not polled for events; park on the store
                    // instead. Resume and answering a question both leave a
                    // terminal state, and nothing but this loop fetches events,
                    // so it must outlive the settlement rather than break on it.
                    // A failed fetch just before settling had no next poll to
                    // recover it, so the trace it left is final — drop the flag.
                    loadFailed = false
                    while !Task.isCancelled, TaskState(liveState).isTerminal {
                        try? await Task.sleep(for: .seconds(1))
                    }
                    continue
                }
                // The server long-poll holds while the run can still produce
                // events on its own — queued and running — and answers at once
                // when it is settled or waiting on a human, so the sleep is
                // unconditional: without it the loop re-sorts the whole trace on
                // the main actor as fast as HTTP allows.
                if loadFailed { try? await Task.sleep(for: .seconds(1)) }
                else { try? await Task.sleep(for: .milliseconds(500)) }
            }
        }
        // Cancel kills the worker process tree, so it always asks first (EC-004).
        .confirmationDialog("Cancel this task?", isPresented: $confirmingCancel) {
            Button("Cancel Task", role: .destructive) {
                Task { await performCancel() }
            }
            Button("Keep Running", role: .cancel) {}
        } message: {
            Text("This stops the worker’s process tree. The task can be resumed later.")
        }
        // Option-click on Resume opens the instruction sheet; a plain click fires
        // the task right away (EC-003).
        .sheet(isPresented: $showingResumeSheet) {
            ResumeSheet { instruction in
                Task { await performResume(instruction: instruction) }
            }
        }
        .alert("Couldn’t update the task.", isPresented: $showingActionError) {
            Button("OK", role: .cancel) {}
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

    /// One identity line, one muted summary. Run facts are one click away rather
    /// than spending the top of every task on ids the reader rarely needs.
    private var header: some View {
        HStack(spacing: 8) {
            StateMarker(state: state, speaks: !state.wantsLabelBesideName)
                .help(state.label)
            Text(task.displayLabel)
                .scaledFont(.title3, weight: .semibold)
                .lineLimit(1)
            if state.wantsLabelBesideName {
                TaskStateChip(state: state)
            }
            TaskMetaChip(text: workerLabel, label: "Worker") {
                if let provider = worker?.provider {
                    ProviderLogo(provider: provider, size: 10 * uiScale)
                } else {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 9 * uiScale, weight: .medium))
                }
            }
            TaskMetaChip(text: task.model, label: "Model") {
                Image(systemName: "cpu").font(.system(size: 9 * uiScale, weight: .medium))
            }
            // The reasoning level the run was dispatched with is part of its
            // identity like the model, and absent when the caller set none.
            if let effort = task.effort, !effort.isEmpty {
                TaskMetaChip(text: effort, label: "Effort") {
                    Image(systemName: "brain").font(.system(size: 9 * uiScale, weight: .medium))
                }
            }
            // Where a run touched files is part of its identity, not a detail: two
            // tasks with the same worker, model and prompt differ only by folder.
            TaskMetaChip(text: task.displayPath, label: "Folder", full: task.cwd, maxChars: 28) {
                Image(systemName: "folder").font(.system(size: 9 * uiScale, weight: .medium))
            }
            Spacer(minLength: 8)
            if let resumeCommand {
                CopyIconButton(
                    text: resumeCommand,
                    label: "Copy resume command — \(resumeCommand)",
                    symbol: "doc.on.clipboard"
                )
            }
            if canResume {
                IconButton(symbol: "arrow.clockwise", label: "Resume task") { resumeAction() }
            }
            if canCancel {
                IconButton(symbol: "xmark.octagon", label: "Cancel task", tint: AnyShapeStyle(.red)) {
                    confirmingCancel = true
                }
            }
            IconButton(symbol: "folder", label: "Open folder") {
                NSWorkspace.shared.open(URL(fileURLWithPath: task.cwd))
            }
            IconButton(
                symbol: task.archivedAt == nil ? "archivebox" : "arrow.uturn.backward",
                label: task.archivedAt == nil ? "Archive task" : "Restore task"
            ) {
                setArchived(task, task.archivedAt == nil)
            }
            IconButton(symbol: "ellipsis", label: "Run details", rotation: .degrees(90)) {
                showingRunFacts.toggle()
            }
            .popover(isPresented: $showingRunFacts, arrowEdge: .bottom) { runFactsPopover }
        }
    }

    /// Only the identifiers worth copying. Worker and model live in the header, so
    /// repeating them here would make the reader check two places for one fact; the
    /// folder repeats because the header shows it shortened and unselectable.
    private var runFactsPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            TaskFactRow(icon: "number", label: "Task", value: task.id, copy: task.id)
            if let sessionId {
                TaskFactRow(icon: "terminal", label: "Session", value: sessionId, copy: sessionId)
            }
            TaskFactRow(icon: "folder", label: "Folder", value: task.cwd, copy: task.cwd)
        }
        .padding(14)
        .frame(width: 380 * uiScale, alignment: .leading)
        // A popover defaults to a vibrant material, which samples whatever is behind
        // the window — over a dark desktop the panel turned into a grey gradient.
        .background(Surface.panel)
        .presentationBackground(Surface.panel)
    }

    /// A profile with its own `command` is opaque to us, so no resume line is
    /// offered for it — same rule the broker applies before resuming a session.
    private var resumeCommand: String? {
        guard let sessionId, let worker, worker.command == nil else { return nil }
        return worker.resumeCommand(session: sessionId)
    }

    private var sessionId: String? {
        let trimmed = task.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Cancel preconditions on the broker: the worker is live or about to be.
    private var canCancel: Bool {
        [.queued, .running, .needsInput, .blocked].contains(state)
    }

    /// Resume preconditions on the broker: the run settled without completing.
    private var canResume: Bool {
        [.failed, .cancelled, .blocked].contains(state)
    }

    private func resumeAction() {
        if NSEvent.modifierFlags.contains(.option) {
            showingResumeSheet = true
        } else {
            Task { await performResume(instruction: nil) }
        }
    }

    private func performCancel() async {
        guard await store.cancelTask(task) else {
            showingActionError = true
            return
        }
    }

    private func performResume(instruction: String?) async {
        guard await store.resumeTask(task, instruction: instruction) else {
            showingActionError = true
            return
        }
    }

    @ViewBuilder private var eventContent: some View {
        if loading {
            TaskPanel {
                HStack { ProgressView().controlSize(.small); Text("Loading trace…").foregroundStyle(.secondary) }
                    .frame(minHeight: 56)
            }
        } else if events.isEmpty {
            if loadFailed {
                TaskPanel {
                    HStack {
                        Label("Couldn’t load activity.", systemImage: "exclamationmark.triangle")
                        Spacer()
                        Button("Retry") { Task { await loadEvents() } }
                    }.frame(minHeight: 56)
                }
            } else {
                TaskPanel {
                    Text("No structured events for this run. New delegated runs stream activity here.")
                        .scaledFont(.body).foregroundStyle(.secondary).frame(minHeight: 56)
                }
            }
        } else {
            if loadFailed {
                // A transient failure must not take the rendered trace down with
                // it; the next successful poll clears this row, so it reads as
                // reconnecting rather than as data loss.
                TaskPanel {
                    HStack(spacing: 8) {
                        Label("Reconnecting…", systemImage: "exclamationmark.triangle")
                        Spacer()
                    }
                    .scaledFont(.caption)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 24)
                }
            }
            if story.blocks.count > visibleBlockLimit {
                Button(showingEarlierActivity
                       ? "Hide earlier blocks"
                       : "Show \(story.blocks.count - visibleBlockLimit) earlier blocks") {
                    showingEarlierActivity.toggle()
                }
                .buttonStyle(.plain)
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .padding(.bottom, 2)
            }
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(displayedBlocks) { block in
                    ActivityBlockView(block: block)
                }
                if showingTechnicalEvents, !story.technical.isEmpty {
                    ActivityChapterCard(rows: story.technical.map(ChapterRow.work), muted: true)
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

    /// The pane follows the tail, so only the newest blocks are laid out; the
    /// scroll anchor asks for the whole content height, which would otherwise
    /// measure a multi-thousand-block trace on every pass.
    private let visibleBlockLimit = 300

    /// The newest blocks, or the whole trace once the reader asked for it.
    private var displayedBlocks: [ActivityBlock] {
        showingEarlierActivity ? story.blocks : Array(story.blocks.suffix(visibleBlockLimit))
    }

    /// Zero-height anchor at the content's edge, the jump control's target. A
    /// marker is just a measured view, so a jump asks the scroller to clamp to
    /// the same bounds a hand scroll would — and a tap fires only when the pane
    /// is on screen, never on open or as events stream in.
    private func jumpMarker(_ id: String) -> some View {
        Color.clear.frame(height: 0).id(id).accessibilityHidden(true)
    }

    private var worker: Profile? {
        store.profiles.first { $0.id == task.profileId }
    }

    private var workerLabel: String {
        worker?.label ?? task.profileId
    }

    private var state: TaskState { TaskState(task.state) }

    /// The store's current word on this task, not the snapshot the pane opened
    /// with — the loop parks on this value, so a stale copy would either keep a
    /// settled pane fetching or miss the resume that should re-arm it.
    private var liveState: String {
        store.tasks.first { $0.id == task.id }?.state ?? task.state
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
        story = ActivityStory.Composition(blocks: [], technical: [])
        eventCursor = 0
        loadedInitialEvents = false
        loading = true
        loadFailed = false
        showingTechnicalEvents = false
        showingEarlierActivity = false
    }

    private func appendEvents(_ incoming: [TaskEventSnapshot]) {
        var known = Set(events.map(\.id))
        let fresh = incoming.filter { known.insert($0.id).inserted }
        guard !fresh.isEmpty else { return }
        events.append(contentsOf: fresh)
        events.sort { $0.id < $1.id }
        story = ActivityStory.compose(events)
    }
}

/// Floating top/bottom jump control over the trace. Always visible — the trace's
/// length moves as events stream in, so an overflow gate would flicker across
/// the whole run; the pill stays put so the reader always knows where it is.
private struct ScrollJumpControl: View {
    let proxy: ScrollViewProxy

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 2 * uiScale) {
            IconButton(symbol: "arrow.up.to.line", label: "Jump to top") {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("top", anchor: .top) }
            }
            IconButton(symbol: "arrow.down.to.line", label: "Jump to bottom") {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .padding(3 * uiScale)
        .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
    }
}

/// Instruction picker for the resume fast path's Option-click: the continued
/// session opens with the field's text, or as-is when it is left blank.
private struct ResumeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var instruction = ""
    let onResume: (String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Resume task").font(.title3.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Resume") {
                    let value = trimmedInstruction
                    dismiss()
                    onResume(value)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(20)
            Divider()
            TextField("Instruction for the worker (optional)", text: $instruction, axis: .vertical)
                .lineLimit(3...8)
                .textFieldStyle(.plain)
                .padding(20)
            Text("The worker sees this at the head of the continued session. Leave it blank to continue as-is.")
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
        }
        .frame(width: 480)
        .background(Surface.content)
    }

    private var trimmedInstruction: String? {
        let value = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
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
        case .chapter(_, let rows):
            ActivityChapterCard(rows: rows, muted: false)
        case .reasoning(let pulse):
            ActivityReasoningRow(pulse: pulse).padding(.horizontal, 14)
        case .signal(let event):
            ActivitySignalCard(event: event)
        case .receipt(let event, let thinkingTokens):
            ActivityReceiptCard(event: event, thinkingTokens: thinkingTokens)
        case .handoff(let boundary):
            ActivityHandoffCard(boundary: boundary)
        }
    }
}

/// A run of work on one flat card: no rails, no dots. Each row leads with what
/// happened; the clock stays out of the way on the right. Thinking sits between
/// the rows it happened between, and needs no rule around it — the line is quiet
/// enough to separate the work on its own.
struct ActivityChapterCard: View {
    let rows: [ChapterRow]
    var muted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                switch row {
                case .work(let event):
                    ActivityWorkRow(event: event, muted: muted)
                case .reasoning(let pulse):
                    ActivityReasoningRow(pulse: pulse)
                }
                if row.isWork, rows.indices.contains(index + 1), rows[index + 1].isWork {
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
                        label: EventExpansion.label(for: event, expanded: showingRawDetails),
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
            if showingRawDetails {
                EventExpansionView(event: event).padding(.top, 3)
            }
        }
        .padding(.vertical, 8)
    }

    /// Agent prose reads as a quotation, not as a titled row.
    private var isQuote: Bool { EventExpansion.isProse(event) }

    /// Expanded, the quotation is only the stub above the text rendered whole.
    @ViewBuilder private var quoteContent: some View {
        HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color(nsColor: .separatorColor))
                .frame(width: 2)
            Text(event.presentation?.text ?? event.detail ?? event.title)
                .scaledFont(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(showingRawDetails ? 1 : 6)
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
        case "file", "command":
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

    /// A path or a command, then what it came to. Both read as one line — the
    /// command used to sit in a box of its own under the title, which spent
    /// three lines and a second surface on what fits beside the name.
    @ViewBuilder private var inlineContent: some View {
        if let presentation = event.presentation, ["file", "command"].contains(presentation.type) {
            HStack(spacing: 8) {
                // A path is identified by its ends, so it loses its middle. A
                // command is read left to right — cutting its middle strands the
                // reader between an env-var prefix and half a pipeline.
                if let subject = presentation.type == "file" ? presentation.path : presentation.command {
                    Text(subject).scaledFont(.caption, design: .monospaced).foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(presentation.type == "file" ? .middle : .tail)
                }
                ForEach(chips, id: \.self) { chip in
                    Text(chip).scaledFont(.caption, weight: .medium, design: .monospaced)
                        .lineLimit(1)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
                }
            }
            .textSelection(.enabled)
        }
    }

    /// What the call came to. A command that ended the ordinary way says so by
    /// not saying anything: `completed · exit 0` next to every green row is three
    /// words for "nothing happened".
    private var chips: [String] {
        guard let presentation = event.presentation else { return [] }
        if presentation.type == "file" {
            return [presentation.change, presentation.outcome].compactMap { $0 }
        }
        return [
            presentation.status.flatMap { ["completed", "success"].contains($0) ? nil : $0 },
            presentation.exitCode.flatMap { $0 == 0 ? nil : "exit \($0)" },
            presentation.outcome,
        ].compactMap { $0 }
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
        .padding(.vertical, 3)
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

/// A task handed off to another profile collapses every run before the current
/// one into a single row. Tapping expands it to reveal each leg with its own
/// boundary line.
private struct ActivityHandoffCard: View {
    let boundary: HandoffBoundary
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } }) {
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Image(systemName: "arrow.triangle.branch")
                        .scaledFont(.caption, weight: .semibold)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Handed off").scaledFont(.callout, weight: .medium)
                        Text(summary).scaledFont(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .scaledFont(.caption2, weight: .semibold)
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(boundary.earlierRuns.enumerated()), id: \.offset) { _, run in
                        if let endedBy = run.endedBy {
                            HStack(spacing: 8) {
                                Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1)
                                Text(endedBy.label)
                                    .scaledFont(.caption, design: .monospaced)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .layoutPriority(1)
                                Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1)
                            }
                            .padding(.horizontal, 14)
                        }
                        ForEach(run.blocks) { block in
                            ActivityBlockView(block: block)
                        }
                    }
                }
                .padding(.top, 6)
                .padding(.leading, 14)
            }
        }
    }

    private var summary: String {
        let count = boundary.earlierRuns.count
        let runWord = count == 1 ? "run" : "runs"
        let eventWord = boundary.hiddenEventCount == 1 ? "event" : "events"
        return "\(boundary.chain) · \(count) earlier \(runWord) · \(boundary.hiddenEventCount) \(eventWord)"
    }
}

/// The run's settlement: cost, turns, duration, and tokens as stats instead of
/// a JSON blob. Denials surface here because this is where they were buried.
private struct ActivityReceiptCard: View {
    let event: TaskEventSnapshot
    /// Summed from the per-turn thinking counters; the receipt itself never
    /// carries a reasoning figure.
    var thinkingTokens = 0
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
        if thinkingTokens > 0 { values.append(("~\(ActivityFormat.count(thinkingTokens))", "reasoning")) }
        if let input = presentation.tokensIn { values.append((ActivityFormat.count(input), "tokens in")) }
        if let cached = presentation.tokensCached { values.append((ActivityFormat.count(cached), "cached")) }
        return values.isEmpty ? [(event.detail ?? "—", "summary")] : Array(values.prefix(6))
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
                ForEach([presentation.change, presentation.outcome].compactMap { $0 }, id: \.self) { chip in
                    Text(chip).scaledFont(.caption, weight: .medium, design: .monospaced)
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
                if presentation.status != nil || presentation.exitCode != nil || presentation.outcome != nil {
                    Text([commandStatus, presentation.outcome].compactMap { $0 }
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                        .scaledFont(.caption2).foregroundStyle(.secondary)
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
            Text([presentation.text, presentation.outcome].compactMap { $0 }
                .filter { !$0.isEmpty }.joined(separator: " · "))
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

/// The word alone — the dot before the task name already carries the shape and
/// the tint, and repeating it inside the chip would say it twice in one line.
private struct TaskStateChip: View {
    let state: TaskState
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        Text(state.label)
            .scaledFont(.caption2, weight: .semibold)
            .padding(.horizontal, 7 * uiScale)
            .padding(.vertical, 3 * uiScale)
            .background(state.tint.opacity(0.14), in: Capsule())
            .accessibilityLabel("State: \(state.label)")
    }
}

/// Shortens a string by removing its middle. The font is monospaced, so a
/// character budget is a width budget: every glyph advances the same amount, and
/// the ellipsis takes the slot of the characters it hides. The head and tail
/// split the budget evenly, so the leading `~/` and the folder name — the two
/// halves that identify a path — both survive.
func middleTruncated(_ text: String, maxChars: Int) -> String {
    guard maxChars > 2, text.count > maxChars else { return text }
    let usable = maxChars - 1
    let head = (usable + 1) / 2
    let tail = usable / 2
    return "\(text.prefix(head))…\(text.suffix(tail))"
}

/// Neutral companion to the state chip: same shape, no semantic color, because a
/// worker or model name is an identifier and not a signal. The icon leads so the
/// field is readable without a label, and the name survives as tooltip and
/// VoiceOver text.
private struct TaskMetaChip<Icon: View>: View {
    let text: String
    let label: String
    /// Unshortened value, when `text` is an abbreviated form of it. The tooltip and
    /// VoiceOver read this one, so nothing is lost to truncation.
    var full: String? = nil
    /// Character budget for values that can run long, like a path. The text is
    /// monospaced, so a character count is a faithful width budget — and unlike a
    /// `frame(maxWidth:)`, it cannot stretch a short value to the full cap, which
    /// left every chip sized to the maximum instead of its content. The middle
    /// goes first so the leading `~/` and the folder name — the two halves that
    /// identify it — stay.
    var maxChars: Int? = nil
    @ViewBuilder let icon: Icon

    @Environment(\.uiScale) private var uiScale

    /// The text as shown: truncated here when a budget is set, so layout never
    /// has to shrink the string itself.
    private var displayText: String {
        maxChars.map { middleTruncated(text, maxChars: $0) } ?? text
    }

    var body: some View {
        HStack(spacing: 4) {
            icon
            Text(displayText)
                .scaledFont(.caption2, design: .monospaced)
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 7 * uiScale)
        .padding(.vertical, 3 * uiScale)
        .background(Surface.sunken, in: Capsule())
        .help(full.map { "\(label) — \($0)" } ?? label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(full ?? text)")
    }
}

/// Icon per tab, one lifted pill for the current section. Three sections is few
/// enough to learn by glyph; the name lives on as the tooltip and the VoiceOver
/// label, so nothing is lost by dropping the word.
private struct TaskSectionTabs: View {
    @Binding var selection: TaskDetailSection
    let hasError: Bool
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 2 * uiScale) {
            ForEach(TaskDetailSection.allCases) { section in
                tab(section)
            }
        }
        .padding(2 * uiScale)
        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.medium))
    }

    private func tab(_ section: TaskDetailSection) -> some View {
        let selected = section == selection
        return Button {
            withAnimation(.easeOut(duration: 0.12)) { selection = section }
        } label: {
            Image(systemName: symbol(section))
                .font(.system(size: 11 * uiScale, weight: .regular))
                .foregroundStyle(tint(section))
                .frame(width: 32 * uiScale, height: 24 * uiScale)
                .background {
                    if selected {
                        RoundedRectangle(cornerRadius: Radius.small).fill(Surface.panel)
                    }
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(label(section))
        .accessibilityLabel(label(section))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func symbol(_ section: TaskDetailSection) -> String {
        hasError && section == .response ? TaskState.failed.symbol : section.symbol
    }

    private func label(_ section: TaskDetailSection) -> String {
        hasError && section == .response ? "Error" : section.label
    }

    /// The error tab is the one place a tab earns color; its glyph changes too, and
    /// the tooltip and VoiceOver label both read "Error".
    private func tint(_ section: TaskDetailSection) -> AnyShapeStyle {
        hasError && section == .response
            ? AnyShapeStyle(TaskState.failed.tint)
            : AnyShapeStyle(section == selection ? .primary : .secondary)
    }
}

private struct TaskFactRow: View {
    let icon: String
    let label: String
    let value: String
    var copy: String?
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11 * uiScale))
                .foregroundStyle(.tertiary)
                .frame(width: 16 * uiScale, alignment: .center)
                .help(label)
                .accessibilityHidden(true)
            Text(value)
                .scaledFont(.caption, design: .monospaced)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .accessibilityLabel("\(label): \(value)")
            Spacer(minLength: 0)
            if let copy {
                CopyIconButton(text: copy, label: "Copy \(label.lowercased())")
            }
        }
    }
}
