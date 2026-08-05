import AppKit
import Foundation
import SwiftUI

/// Declaration order is the tab strip's order: activity leads because it is
/// where a run is read, and the prompt and the answer sit behind it.
enum TaskDetailSection: String, CaseIterable, Identifiable {
    case activity
    case request
    case response

    var id: Self { self }

    /// The tab strip's visible name for the section.
    var label: String {
        switch self {
        case .request: "Request"
        case .response: "Response"
        case .activity: "Activity"
        }
    }
}

struct TaskDetail: View {
    let taskId: String
    /// The sidebar's summary row — always available so the header reads
    /// immediately while the full detail loads.
    let listItem: TaskListItem
    let store: ProfileStore
    let setArchived: (String, Bool) -> Void
    /// Activity is where a run is read — the response is one tab away, and landing
    /// there mid-run would mean opening on an empty panel.
    @State private var section: TaskDetailSection = .activity
    /// Full task row fetched on open and refetched when the summary's state or
    /// updatedAt changes. Nil until the first fetch lands.
    @State private var task: TaskSnapshot?
    @State private var detailLoaded = false
    @State private var events: [TaskEventSnapshot] = []
    /// The retelling of `events`, composed off the MainActor and published back.
    @State private var story = ActivityStory.Composition(blocks: [], technical: [])
    @State private var eventCursor = 0
    @State private var loadedInitialEvents = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showingTechnicalEvents = false
    @State private var showingRunFacts = false
    @State private var confirmingCancel = false
    @State private var showingResumeSheet = false
    @State private var showingActionError = false
    /// In-flight resume/cancel calls — the pressed control swaps to a spinner
    /// so the run's settle reads as busy instead of dead.
    @State private var resumeInFlight = false
    @State private var cancelInFlight = false
    /// Whether activity opens on its newest event. Fixed when the task opens: a
    /// run that lands while it is being read would otherwise yank the trace back
    /// to the top under the reader.
    @State private var followsTail: Bool
    /// Tail-paging — oldest event id loaded and whether the server has more.
    @State private var oldestId: Int = 0
    @State private var hasEarlier = false
    @State private var loadingEarlier = false
    /// Whether the fast catch-up loop has run once after the initial tail load.
    @State private var catchUpDone = false
    /// Single-flight compose coalescing: one in-flight at a time, at most one
    /// pending re-run when events land mid-compose.
    @State private var composeInFlight = false
    @State private var pendingCompose = false
    /// Bumped when the pane starts on a new task, so an in-flight compose from
    /// the previous task is dropped instead of painting its blocks over the new
    /// task's trace. State, not a plain property: only State storage is shared
    /// between the view's copies, so the guard reads the current identity.
    @State private var composeGeneration = 0
    @Environment(\.uiScale) private var uiScale

    init(taskId: String, listItem: TaskListItem, store: ProfileStore, setArchived: @escaping (String, Bool) -> Void) {
        self.taskId = taskId
        self.listItem = listItem
        self.store = store
        self.setArchived = setArchived
        // A finished run is read from the beginning; only a live one is read from
        // the end, where the next event will land.
        _followsTail = State(initialValue: !TaskState(listItem.state).isTerminal)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                if resolvedTaskState == "needs_input", let question = resolvedQuestion {
                    NeedsInputBanner(question: question)
                        .transition(.opacity)
                }
                HStack(spacing: 0) {
                    TaskSectionTabs(selection: $section, hasError: resolvedError != nil)
                    Spacer(minLength: 0)
                }
            }
            .animation(.easeOut(duration: 0.2), value: resolvedTaskState)
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
                // The jump pills float over the trace's bottom edge, so content
                // scrolls clear of them instead of hiding behind the control.
                .contentMargins(.bottom, 56 * uiScale, for: .scrollContent)
                // A new section gets a new scroll view, so it opens at its own
                // anchor instead of the previous section's offset. The swap stays
                // unanimated: a cross-fade holds both sections on screen at their
                // own offsets, and the outgoing one's trailing text lands over the
                // incoming one's content.
                .id("\(taskId)-\(section.rawValue)")
                // Scrolling to a sentinel at the end of the list put the view past the
                // content whenever the rows under it had not been measured yet — the
                // panel opened blank, and nothing re-clamped it. The anchor asks for
                // the same thing against the real content size, so it cannot overshoot,
                // and it keeps holding the tail as events stream in.
                .defaultScrollAnchor(followsTail && section == .activity ? .bottom : .top)
                .overlay(alignment: .bottom) {
                    ScrollJumpControl(proxy: proxy)
                        .padding(.bottom, 16 * uiScale)
                }
            }
        }
        .background(Surface.content)
        .task(id: taskId) {
            await refreshDetailIfStale()
            resetEventState()
            while !Task.isCancelled {
                await loadEvents()
                await refreshDetailIfStale()
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
                        await refreshDetailIfStale()
                    }
                    continue
                }
                // The server long-poll holds while the run can still produce
                // events on its own — queued and running — and answers at once
                // when it is settled or waiting on a human, so the sleep is
                // unconditional: without it the loop re-uses the same pattern.
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
            if let prompt = task?.prompt {
                TaskPanel { ReviewContentView(source: prompt) }
            } else {
                TaskPanel {
                    HStack { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(.secondary) }
                        .frame(minHeight: 56)
                }
            }
        case .response:
            if let error = resolvedError {
                TaskPanel(accent: .red) { ReviewContentView(source: error) }
            } else if let output = task?.output, !output.isEmpty {
                TaskPanel { ReviewContentView(source: output) }
            } else if task == nil {
                TaskPanel {
                    HStack { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(.secondary) }
                        .frame(minHeight: 56)
                }
            } else {
                ContentUnavailableView(
                    "No response yet",
                    systemImage: "text.bubble",
                    description: Text("The worker's response will appear here.")
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
            // Speaks, because the marker is now the only place the state is
            // stated: the chip that used to say the word beside it is gone.
            StateMarker(state: state, speaks: true)
                .help(state.label)
            Text(resolvedLabel)
                .scaledFont(.body, weight: .semibold)
                .lineLimit(1)
                .help(resolvedLabel)
            // No state chip: the marker beside the title already carries the
            // state — pulsing while live, tinted and shaped once settled — and
            // spelling it out again cost a chip that resized between states and
            // shoved every chip right of it.
            // Worker and model share one chip: the list the reader clicked from
            // already named the pair, so here it confirms instead of teaching.
            TaskMetaChip(text: identityLine, label: "Worker and model", full: identityLine) {
                if let provider = worker?.provider {
                    ProviderLogo(provider: provider, size: 9 * uiScale)
                } else {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 8 * uiScale, weight: .medium))
                }
            }
            // The reasoning level the run was dispatched with is part of its
            // identity like the model, and absent when the caller set none.
            if let effort = task?.effort, !effort.isEmpty {
                TaskMetaChip(text: effort, label: "Effort") {
                    Image(systemName: "brain").font(.system(size: 8 * uiScale, weight: .medium))
                }
            }
            // Where a run touched files is part of its identity, not a detail: two
            // tasks with the same worker, model and prompt differ only by folder.
            TaskMetaChip(text: resolvedDisplayPath, label: "Folder", full: resolvedCwd, maxChars: 28) {
                Image(systemName: "folder").font(.system(size: 8 * uiScale, weight: .medium))
            }
            Spacer(minLength: 8)
            if let resumeCommand {
                CopyIconButton(
                    text: resumeCommand,
                    label: "Copy resume command — \(resumeCommand)",
                    symbol: "doc.on.clipboard"
                )
                .font(.system(size: 12 * uiScale))
            }
            if canResume {
                if resumeInFlight {
                    ProgressView().controlSize(.small)
                        .frame(width: 24 * uiScale, height: 24 * uiScale)
                        .help("Resuming task…")
                } else {
                    IconButton(symbol: "arrow.clockwise", label: "Resume task") { resumeAction() }
                        .font(.system(size: 12 * uiScale))
                }
            }
            if canCancel {
                if cancelInFlight {
                    ProgressView().controlSize(.small)
                        .frame(width: 24 * uiScale, height: 24 * uiScale)
                        .help("Cancelling task…")
                } else {
                    IconButton(symbol: "xmark.octagon", label: "Cancel task", tint: AnyShapeStyle(.red)) {
                        confirmingCancel = true
                    }
                    .font(.system(size: 12 * uiScale))
                }
            }
            IconButton(symbol: "folder", label: "Open folder") {
                NSWorkspace.shared.open(URL(fileURLWithPath: resolvedCwd))
            }
            .font(.system(size: 12 * uiScale))
            IconButton(
                symbol: resolvedArchivedAt == nil ? "archivebox" : "arrow.uturn.backward",
                label: resolvedArchivedAt == nil ? "Archive task" : "Restore task"
            ) {
                setArchived(taskId, resolvedArchivedAt == nil)
            }
            .font(.system(size: 12 * uiScale))
            IconButton(symbol: "ellipsis", label: "Run details", rotation: .degrees(90)) {
                showingRunFacts.toggle()
            }
            .font(.system(size: 12 * uiScale))
            .popover(isPresented: $showingRunFacts, arrowEdge: .bottom) { runFactsPopover }
        }
    }

    /// Only the identifiers worth copying. Worker and model live in the header, so
    /// repeating them here would make the reader check two places for one fact; the
    /// folder repeats because the header shows it shortened and unselectable.
    private var runFactsPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            TaskFactRow(icon: "number", label: "Task", value: taskId, copy: taskId)
            if let sessionId {
                TaskFactRow(icon: "terminal", label: "Session", value: sessionId, copy: sessionId)
            }
            TaskFactRow(icon: "folder", label: "Folder", value: resolvedCwd, copy: resolvedCwd)
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
        let trimmed = task?.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
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
        cancelInFlight = true
        defer { cancelInFlight = false }
        guard await store.cancelTask(taskId) else {
            showingActionError = true
            return
        }
    }

    private func performResume(instruction: String?) async {
        resumeInFlight = true
        defer { resumeInFlight = false }
        guard await store.resumeTask(taskId, instruction: instruction) else {
            showingActionError = true
            return
        }
    }

    @ViewBuilder private var eventContent: some View {
        // The branch below renders `story`, but events land before the compose
        // that turns them into blocks does. Until the first composition arrives
        // the trace has nothing to draw, so the wait belongs with the spinner —
        // not in the branch that assumes composed blocks exist.
        if loading || awaitingFirstComposition {
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
            if hasEarlier {
                Button {
                    Task { await loadEarlierEvents() }
                } label: {
                    if loadingEarlier {
                        HStack(spacing: 4) { ProgressView().controlSize(.small); Text("Loading…") }
                    } else {
                        Text("Load earlier activity")
                    }
                }
                .buttonStyle(.plain)
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .disabled(loadingEarlier)
                .padding(.bottom, 2)
            }
            if story.blocks.count > visibleBlockLimit {
                Text("Showing the newest \(visibleBlockLimit) of \(story.blocks.count) blocks")
                    .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.tertiary)
                    .padding(.bottom, 2)
            }
            LazyVStack(alignment: .leading, spacing: 16) {
                ForEach(displayedBlocks) { block in
                    ActivityBlockView(block: block, live: !TaskState(liveState).isTerminal)
                }
                if showingTechnicalEvents, !story.technical.isEmpty {
                    ActivityChapterCard(rows: story.technical.map(ChapterRow.work), muted: true, live: false)
                }
                if !story.technical.isEmpty {
                    Button(showingTechnicalEvents
                           ? "Hide technical events"
                           : "Show \(story.technical.count) technical \(story.technical.count == 1 ? "event" : "events")") {
                        showingTechnicalEvents.toggle()
                    }
                    .buttonStyle(.plain)
                    .scaledFont(.caption, monospacedDigit: true)
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

    /// The newest blocks — the 300-block cap limits layout measurement, not
    /// what the user can scroll to (LazyVStack renders on demand).
    private var displayedBlocks: [ActivityBlock] {
        Array(story.blocks.suffix(visibleBlockLimit))
    }

    /// Events are in hand but the composition that renders them is not. A run
    /// whose events all compose away to nothing is not waiting — it has its
    /// answer, and an empty story is that answer.
    private var awaitingFirstComposition: Bool {
        composeInFlight && !events.isEmpty && story.blocks.isEmpty && story.technical.isEmpty
    }

    /// Zero-height anchor at the content's edge, the jump control's target. A
    /// marker is just a measured view, so a jump asks the scroller to clamp to
    /// the same bounds a hand scroll would — and a tap fires only when the pane
    /// is on screen, never on open or as events stream in.
    private func jumpMarker(_ id: String) -> some View {
        Color.clear.frame(height: 0).id(id).accessibilityHidden(true)
    }

    private var worker: Profile? {
        store.profiles.first { $0.id == resolvedProfileId }
    }

    private var workerLabel: String {
        worker?.label ?? resolvedProfileId
    }

    /// The task's model — from the full detail when loaded, the summary otherwise.
    private var resolvedModel: String {
        task?.model ?? listItem.model
    }

    /// The pair the header shows in one chip, echoing the list's own `worker · model`
    /// line so the reader sees the same facts they scanned a moment ago.
    private var identityLine: String { "\(workerLabel) · \(resolvedModel)" }

    /// Fields shared across summary and full-detail rows, falling back from the
    /// fetched snapshot to the sidebar's list item.
    private var resolvedLabel: String { task?.displayLabel ?? listItem.displayLabel }
    private var resolvedTaskState: String { task?.state ?? listItem.state }
    private var resolvedCwd: String { task?.cwd ?? listItem.cwd }
    private var resolvedProfileId: String { task?.profileId ?? listItem.profileId }
    private var resolvedError: String? { task?.error ?? listItem.error }
    private var resolvedQuestion: String? { task?.question ?? listItem.question }
    private var resolvedArchivedAt: String? { task?.archivedAt ?? listItem.archivedAt }
    private var resolvedDisplayPath: String { task?.displayPath ?? listItem.displayPath }

    private var state: TaskState { TaskState(resolvedTaskState) }

    /// The store's current word on this task, not the snapshot the pane opened
    /// with — the loop parks on this value, so a stale copy would either keep a
    /// settled pane fetching or miss the resume that should re-arm it.
    private var liveState: String {
        store.tasks.first { $0.id == taskId }?.state ?? resolvedTaskState
    }

    /// The summary row as it stands right now — used to detect when the detail
    /// should be refetched.
    private var currentListItem: TaskListItem? {
        store.tasks.first { $0.id == taskId }
    }

    /// Refetches the full row whenever the summary has moved past the copy on
    /// screen. Runs on every pass of the polling loop — including the parked
    /// terminal loop, where completion lands the output the Response tab shows.
    private func refreshDetailIfStale() async {
        guard task?.updatedAt != currentListItem?.updatedAt || task?.state != currentListItem?.state else { return }
        guard let fetched = await store.taskDetail(id: taskId), !Task.isCancelled else { return }
        task = fetched
        detailLoaded = true
    }

    // MARK: - Event loading (tail-first, compose off-main)

    private func loadEvents() async {
        if !loadedInitialEvents {
            await loadInitialTail()
            return
        }
        // Follow loop: long-poll for events newer than cursor. Only live tasks
        // produce events, so a terminal state is a no-op here.
        if !TaskState(liveState).isTerminal {
            await loadNewerEvents()
        }
    }

    /// Fetches the newest 1500 events. The pane opens on the tail — the reader
    /// lands where the action is, not on event #1.
    private func loadInitialTail() async {
        do {
            var components = URLComponents(
                url: InterServer.api("tasks/\(taskId)/events"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [URLQueryItem(name: "last", value: "1500")]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard !Task.isCancelled else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                loadFailed = true; loading = false; return
            }
            if let page = try? JSONDecoder().decode(TaskEventPage.self, from: data) {
                events = page.events
                eventCursor = page.cursor
                oldestId = page.oldestId ?? 0
                hasEarlier = page.hasEarlier ?? false
                scheduleCompose()
                loadedInitialEvents = true
            }
            loadFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            loadFailed = true
        }
        loading = false
    }

    /// Long-poll for events after the cursor. One fast catch-up pass runs after
    /// the initial tail load to grab events that landed in the gap; after that,
    /// each call holds for up to 25s while the worker is live.
    private func loadNewerEvents() async {
        if !catchUpDone {
            await pollEvents(waitMs: 0)
            catchUpDone = true
        }
        await pollEvents(waitMs: 25000)
    }

    /// Fetches events after the cursor with the given wait, looping while
    /// `hasMore` is true so a multi-page backlog drains in one pass.
    private func pollEvents(waitMs: Int) async {
        var hasMore = true
        while hasMore, !Task.isCancelled {
            do {
                var components = URLComponents(
                    url: InterServer.api("tasks/\(taskId)/events"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [
                    URLQueryItem(name: "after", value: String(eventCursor)),
                    URLQueryItem(name: "waitMs", value: String(waitMs)),
                ]
                let (data, response) = try await URLSession.shared.data(from: components.url!)
                guard !Task.isCancelled else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    loadFailed = true; return
                }
                if let page = try? JSONDecoder().decode(TaskEventPage.self, from: data) {
                    let fresh = EventMerge.appendInOrder(page.events, after: events)
                    if fresh.isEmpty, !page.events.isEmpty {
                        // Overlap — merge with sort
                        let known = Set(events.map(\.id))
                        let deduped = page.events.filter { !known.contains($0.id) }
                        events.append(contentsOf: deduped)
                        events.sort { $0.id < $1.id }
                    } else {
                        events.append(contentsOf: fresh)
                    }
                    eventCursor = max(eventCursor, page.cursor)
                    hasMore = page.hasMore
                    scheduleCompose()
                }
                loadFailed = false
            } catch {
                guard !Task.isCancelled else { return }
                loadFailed = true
                return
            }
        }
    }

    /// Fetches older events before `oldestId`, prepends them, and recomposes.
    func loadEarlierEvents() async {
        guard !loadingEarlier, hasEarlier else { return }
        loadingEarlier = true
        do {
            var components = URLComponents(
                url: InterServer.api("tasks/\(taskId)/events"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [
                URLQueryItem(name: "before", value: String(oldestId)),
                URLQueryItem(name: "last", value: "1500"),
            ]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard !Task.isCancelled else { loadingEarlier = false; return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                loadingEarlier = false; return
            }
            if let page = try? JSONDecoder().decode(TaskEventPage.self, from: data) {
                let fresh = EventMerge.prependInOrder(page.events, before: events)
                if fresh.isEmpty, !page.events.isEmpty {
                    // Overlap — merge with sort
                    let known = Set(events.map(\.id))
                    let deduped = page.events.filter { !known.contains($0.id) }
                    events = deduped + events
                    events.sort { $0.id < $1.id }
                } else {
                    events = fresh + events
                }
                oldestId = page.oldestId ?? oldestId
                hasEarlier = page.hasEarlier ?? false
                scheduleCompose()
            }
        } catch {}
        loadingEarlier = false
    }

    private func resetEventState() {
        events = []
        story = ActivityStory.Composition(blocks: [], technical: [])
        eventCursor = 0
        loadedInitialEvents = false
        loading = true
        loadFailed = false
        showingTechnicalEvents = false
        oldestId = 0
        hasEarlier = false
        loadingEarlier = false
        catchUpDone = false
        composeGeneration += 1
    }

    // MARK: - Compose coalescing

    /// Schedules an off-main compose. If one is already in flight, marks a
    /// pending re-run so the latest events always win without stacking work.
    private func scheduleCompose() {
        if composeInFlight {
            pendingCompose = true
            return
        }
        composeInFlight = true
        let snapshot = events
        // The pane keeps its identity when the sidebar switches tasks, so a
        // compose that finishes after the switch must not paint the previous
        // task's blocks over the new task's trace.
        let generation = composeGeneration
        Task.detached(priority: .userInitiated) {
            let result = ActivityStory.compose(snapshot)
            await self.applyComposition(result, generation: generation)
        }
    }

    @MainActor
    private func applyComposition(_ comp: ActivityStory.Composition, generation: Int) {
        guard generation == composeGeneration else {
            composeInFlight = false
            pendingCompose = false
            return
        }
        story = comp
        composeInFlight = false
        if pendingCompose {
            pendingCompose = false
            scheduleCompose()
        }
    }
}

/// Full date-time for tooltips. EventClock in ActivityStory formats only the
/// time of day; a full formatter would live next to it, but that file is under
/// concurrent edit, so the formatting line is mirrored here instead.
private enum DetailClock {
    static func dateTime(_ value: String) -> String {
        guard let date = EventClock.date(value) else { return value }
        return date.formatted(date: .abbreviated, time: .standard)
    }
}

/// Floating top/bottom jump control at the bottom centre of the trace. Always
/// visible — the trace's length moves as events stream in, so an overflow gate
/// would flicker across the whole run; the pair stays put so the reader always
/// knows where it is.
private struct ScrollJumpControl: View {
    let proxy: ScrollViewProxy

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 2 * uiScale) {
            IconButton(symbol: "chevron.up", label: "Jump to top") {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("top", anchor: .top) }
            }
            IconButton(symbol: "chevron.down", label: "Jump to bottom") {
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
    @FocusState private var instructionFocused: Bool
    /// Return can fire both the field's submit and the default-action shortcut;
    /// the flag keeps a double trigger from resuming twice.
    @State private var submitted = false
    let onResume: (String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Resume task").font(.title3.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Resume") { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(20)
            Divider()
            TextField("Instruction for the worker (optional)", text: $instruction, axis: .vertical)
                .lineLimit(3...8)
                .textFieldStyle(.plain)
                .focused($instructionFocused)
                .onSubmit(submit)
                .padding(20)
            Text("The worker sees this at the head of the continued session. Leave it blank to continue as-is.")
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
        }
        .frame(width: 480)
        .background(Surface.content)
        .onAppear { instructionFocused = true }
    }

    private func submit() {
        guard !submitted else { return }
        submitted = true
        let value = trimmedInstruction
        dismiss()
        onResume(value)
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
            AccentRule(color: .orange)
                .accessibilityHidden(true)
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
        .onAppear {
            AccessibilityNotification.Announcement("Task needs input").post()
        }
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
    /// Present-tense verbs while the current run is still moving; earlier
    /// handoff legs and the technical list are always past tense.
    var live = false

    var body: some View {
        switch block {
        case .chapter(_, let rows):
            ActivityChapterCard(rows: rows, muted: false, live: live)
        case .reasoning(let pulse):
            ActivityReasoningRow(pulse: pulse)
        case .signal(let event):
            ActivitySignalCard(event: event)
        case .receipt(let event, let thinkingTokens):
            ActivityReceiptCard(event: event, thinkingTokens: thinkingTokens)
        case .handoff(let boundary):
            ActivityHandoffCard(boundary: boundary)
        }
    }
}

/// A run of work flowing straight on the page surface: no card, no rules
/// between rows — spacing and the leading verb column separate the work.
/// Muted renders the whole run dimmer, which is how the technical list stays
/// behind the real trace.
struct ActivityChapterCard: View {
    let rows: [ChapterRow]
    var muted = false
    var live = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row {
                case .work(let event):
                    ActivityWorkRow(event: event, muted: muted, live: live)
                case .reasoning(let pulse):
                    ActivityReasoningRow(pulse: pulse)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(muted ? 0.72 : 1)
    }
}

private struct ActivityWorkRow: View {
    let event: TaskEventSnapshot
    var muted = false
    /// Present tense while the run is still moving; past once it settles.
    var live = false
    @State private var showingRawDetails = false

    /// The verb that opens the row, when the title is a known tool.
    private var verb: String? { ToolIcon.verb(for: event, live: live) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                if isQuote {
                    quoteContent
                } else {
                    // The verb is a label and the subject — a path, a
                    // command — is the content a reader scans for, so the
                    // two never look alike: the verb sits a rung below body
                    // text at medium weight and secondary color, the subject
                    // regular primary in mono. Failure still needs to read
                    // at a glance, so both the verb and an unrecognized
                    // title stay the same red.
                    if let verb = verb {
                        Text(verb)
                            .scaledFont(.callout, weight: .regular)
                            .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                            .lineLimit(1)
                            .layoutPriority(1)
                    } else {
                        // An unrecognized title keeps itself as the row name
                        // — never an invented verb, and never a glyph in its
                        // place: an MCP call title is the only thing that
                        // says which tool ran.
                        Text(event.title)
                            .scaledFont(.callout, weight: .medium, design: .monospaced)
                            .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                            .layoutPriority(1)
                    }
                    inlineContent(subjectTint: verb == nil ? Color.secondary : Color.primary)
                }
                if EventExpansion.shouldOfferExpansion(event) {
                    IconButton(
                        symbol: showingRawDetails ? "chevron.down" : "chevron.right",
                        label: EventExpansion.label(for: event, expanded: showingRawDetails),
                        tint: AnyShapeStyle(.tertiary)
                    ) {
                        withAnimation(.easeOut(duration: 0.15)) { showingRawDetails.toggle() }
                    }
                    .scaledFont(.caption2, weight: .semibold)
                }
                Spacer(minLength: 12)
                Text(EventClock.time(event.createdAt))
                    .scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary)
                    .help(DetailClock.dateTime(event.createdAt))
            }
            if let presentation = blockPresentation {
                TaskEventPresentationView(presentation: presentation)
            }
            if showingRawDetails {
                EventExpansionView(event: event).padding(.top, 3).transition(.opacity)
            }
        }
        .padding(.vertical, 5)
    }

    /// Agent prose reads as a quotation, not as a titled row.
    private var isQuote: Bool { EventExpansion.isProse(event) }

    /// The stub is one line either way: collapsed it is all the row shows, and
    /// expanded the same line sits above the text rendered whole below it.
    @ViewBuilder private var quoteContent: some View {
        HStack(alignment: .top, spacing: 9) {
            AccentRule()
                .accessibilityHidden(true)
            Text(event.presentation?.text ?? event.detail ?? event.title)
                .scaledFont(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(EventExpansion.quotePreviewLines)
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
    /// three lines and a second surface on what fits beside the name. The
    /// subject sits at `subjectTint`: primary when a verb leads the row (the
    /// target is the content), secondary under a glyph or a plain title.
    @ViewBuilder private func inlineContent(subjectTint: Color) -> some View {
        if let presentation = event.presentation, ["file", "command"].contains(presentation.type) {
            HStack(spacing: 8) {
                // A path is identified by its ends, so it loses its middle. A
                // command is read left to right — cutting its middle strands the
                // reader between an env-var prefix and half a pipeline.
                if let subject = presentation.type == "file" ? presentation.path : presentation.command {
                    Text(subject).scaledFont(.caption, design: .monospaced).foregroundStyle(subjectTint)
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
        Text(label)
            .scaledFont(.caption, design: .monospaced)
            .italic()
            .foregroundStyle(.secondary)
            .padding(.vertical, 3)
    }

    private var label: String {
        // compose() keeps either a counter ("~5.2k tokens") or the prose
        // fallback "Thinking"; only counters get the prefix, so a counter
        // without the tilde still reads "Reasoned 5.2k tokens".
        var parts = [pulse.detail == "Thinking" ? "Thinking" : "Reasoned \(pulse.detail)"]
        if let seconds = pulse.seconds, seconds > 0 { parts.append(ActivityFormat.duration(seconds * 1000)) }
        return parts.joined(separator: " · ")
    }
}

/// Retries, rate limits, stalls, questions, and broker failures read as a
/// tinted 2pt rule on the page's edge plus the line itself — color stays a
/// hairline here, never a filled strip. A glyph beside the rule would say the
/// same thing a third time: the rule's tint already marks severity, and the
/// title already names what happened.
private struct ActivitySignalCard: View {
    let event: TaskEventSnapshot

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            AccentRule(color: tint)
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
                .help(DetailClock.dateTime(event.createdAt))
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
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
}

/// A task handed off to another profile collapses every run before the current
/// one into a single row. Tapping expands it to reveal each leg with its own
/// boundary line.
private struct ActivityHandoffCard: View {
    let boundary: HandoffBoundary
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CollapsibleSection(
                isExpanded: $expanded,
                label: {
                    HStack(spacing: 9) {
                        AccentRule()
                            .accessibilityHidden(true)
                        EventIcon(symbol: "arrow.triangle.branch", weight: .semibold)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Handed off").scaledFont(.callout, weight: .medium)
                            Text(summary).scaledFont(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 10)
                },
                panel: false
            )

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
                            ActivityBlockView(block: block, live: false)
                        }
                    }
                }
                .padding(.top, 6)
                .transition(.opacity)
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
            if event.rawText != nil {
                CollapsibleSection(
                    isExpanded: $showingRawDetails,
                    label: { receiptTitle },
                    trailing: { receiptTimestamp }
                )
            } else {
                HStack {
                    receiptTitle
                    Spacer(minLength: 0)
                    receiptTimestamp
                }
            }
            HStack(alignment: .top, spacing: 28) {
                ForEach(stats, id: \.label) { stat in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stat.value)
                            .scaledFont(.title3, weight: .semibold, design: .rounded, monospacedDigit: true)
                        Text(stat.label)
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if let warning = event.presentation?.text {
                Text(warning)
                    .scaledFont(.caption, weight: .medium)
                    .foregroundStyle(.orange)
            }
            if showingRawDetails, let raw = event.rawText {
                ReviewContentView(source: raw, initiallyExpandJSON: false)
                    .transition(.opacity)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.panel, in: RoundedRectangle(cornerRadius: Radius.medium))
    }

    private var receiptTitle: some View {
        Text(event.phase == "failed" ? "Run failed" : "Run settled")
            .scaledFont(.caption, weight: .semibold, design: .monospaced)
            .tracking(0.5)
            .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .textCase(.uppercase)
    }

    private var receiptTimestamp: some View {
        Text(EventClock.time(event.createdAt))
            .scaledFont(.caption2, design: .monospaced).foregroundStyle(.tertiary)
            .help(DetailClock.dateTime(event.createdAt))
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
        return values.isEmpty ? [(event.detail ?? "—", "summary")] : values
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
            if presentation.command == nil,
               presentation.status == nil,
               presentation.exitCode == nil,
               presentation.outcome == nil {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    if let command = presentation.command {
                        Text(Self.collapsedLine(command))
                            .scaledFont(.caption, design: .monospaced)
                            .lineLimit(1)
                            .textSelection(.enabled)
                    }
                    if presentation.status != nil || presentation.exitCode != nil || presentation.outcome != nil {
                        Text([commandStatus, presentation.outcome].compactMap { $0 }
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 7).padding(.vertical, 5)
                .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
            }
        case "message":
            Text(Self.collapsedLine(presentation.text ?? ""))
                .scaledFont(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .textSelection(.enabled)
        case "tool":
            // The outcome already reads on the title line as a chip, so the
            // collapsed line carries only the call's own text.
            if let text = presentation.text, !text.isEmpty {
                Text(Self.collapsedLine(text))
                    .scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
        case "todo":
            HStack(spacing: 8) {
                if let total = presentation.total, total > 0 {
                    ProgressView(
                        value: Double(presentation.completed ?? 0),
                        total: Double(total)
                    )
                    .frame(width: 72 * uiScale)
                    Text("\(presentation.completed ?? 0) of \(total) complete")
                        .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.secondary)
                } else {
                    // No denominator — a full bar with a zero total would lie.
                    Text(todoSummary)
                        .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.secondary)
                }
                if let active = presentation.text {
                    Text(active).scaledFont(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
        default:
            EmptyView()
        }
    }

    private var todoSummary: String {
        let done = presentation.completed ?? 0
        return done > 0 ? "\(done) done" : "No todo items yet"
    }

    private var commandStatus: String {
        [
            presentation.status,
            presentation.exitCode.map { "exit \($0)" },
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    /// The collapsed row's one line: the first non-empty line, whitespace runs
    /// collapsed — a multi-line blob must not render as several lines.
    private static func collapsedLine(_ text: String) -> String {
        guard let line = text.split(whereSeparator: \.isNewline).first else { return "" }
        return line.split(whereSeparator: \.isWhitespace).joined(separator: " ")
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
        HStack(spacing: 3 * uiScale) {
            icon
            Text(displayText)
                .scaledFont(.caption2, design: .monospaced)
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        // The text is already on the ladder's bottom rung, so the chip's size is
        // set by what surrounds it: padding, the gap, and the icon.
        .padding(.horizontal, 5 * uiScale)
        .padding(.vertical, 2 * uiScale)
        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
        .help(full.map { "\(label) — \($0)" } ?? label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(full ?? text)")
    }
}

/// Named tabs under a sliding rule. Three sections is few enough to spell out,
/// and a word is read where an outline glyph this small has to be learned first.
/// No well and no filled pill: the current section is the one at full strength
/// with the rule under it, so the strip reads as a line of text rather than a
/// third box in a header that already has two.
private struct TaskSectionTabs: View {
    @Binding var selection: TaskDetailSection
    let hasError: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        HStack(spacing: 14 * uiScale) {
            ForEach(TaskDetailSection.allCases) { section in
                tab(section)
            }
        }
        // Scoped to the strip: an animation wide enough to reach the section's
        // content would cross-fade two scroll views over each other.
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 1), value: selection)
    }

    private func tab(_ section: TaskDetailSection) -> some View {
        let selected = section == selection
        return Button {
            selection = section
        } label: {
            HStack(spacing: 4 * uiScale) {
                if hasError, section == .response {
                    Image(systemName: TaskState.failed.symbol)
                        .font(.system(size: 9 * uiScale, weight: .semibold))
                }
                // Weight carries the selection, and the hidden bold copy under
                // it reserves the wider of the two widths — so the strip holds
                // still instead of shifting sideways as the weight changes.
                Text(label(section))
                    .scaledFont(.footnote, weight: .semibold)
                    .hidden()
                    .overlay {
                        Text(label(section))
                            .scaledFont(.footnote, weight: selected ? .semibold : .regular)
                    }
            }
            .foregroundStyle(tint(section))
            .padding(.vertical, 4 * uiScale)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(section))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func label(_ section: TaskDetailSection) -> String {
        hasError && section == .response ? "Error" : section.label
    }

    /// The error tab is the one place a tab earns color, and it keeps a glyph
    /// beside the word so the signal survives without it.
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

    var body: some View {
        HStack(spacing: 8) {
            EventIcon(symbol: icon)
                .foregroundStyle(.tertiary)
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
