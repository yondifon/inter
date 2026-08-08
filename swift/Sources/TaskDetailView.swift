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
    /// Every file the run changed, gathered alongside the retelling.
    @State private var changes = RunChangeSet.empty
    /// The changed-files panel starts closed — the trace is what the pane is
    /// opened for, and review comes after it.
    @State private var showingChanges = false
    @State private var eventCursor = 0
    @State private var loadedInitialEvents = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showingTechnicalEvents = false
    @State private var confirmingCancel = false
    @State private var showingResumeSheet = false
    @State private var showingFollowUpSheet = false
    @State private var showingActionError = false
    /// In-flight resume/cancel calls — the pressed control swaps to a spinner
    /// so the run's settle reads as busy instead of dead.
    @State private var resumeInFlight = false
    @State private var cancelInFlight = false
    @State private var markCompleteInFlight = false
    /// Whether activity opens on its newest event. Fixed when the task opens: a
    /// run that lands while it is being read would otherwise yank the trace back
    /// to the top under the reader.
    @State private var followsTail: Bool
    /// Whether this open should land on the run's closing response. Fixed from
    /// the state the task had when the pane opened — same reasoning as
    /// `followsTail`: a task that settles while already open must not yank the
    /// reader to a response they weren't reading toward.
    @State private var wantsInitialFocus: Bool
    /// Set once the initial scroll-to-response has been attempted, so a later
    /// recompose (a technical-events toggle, a late event) never fires it twice.
    @State private var hasAppliedInitialFocus = false
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
        _wantsInitialFocus = State(initialValue: TaskDetail.isSettled(TaskState(listItem.state)))
    }

    /// Settled, with a response worth landing on — as opposed to `isTerminal`,
    /// which also covers `needsInput`/`answered`: a run mid-turn waiting on a
    /// human has nothing closing to focus yet.
    private static func isSettled(_ state: TaskState) -> Bool {
        [.completed, .failed, .blocked, .cancelled].contains(state)
    }

    var body: some View {
        HStack(spacing: 0) {
            taskColumn
            if showingChanges {
                Divider()
                RunChangesPanel(
                    changes: changes,
                    loading: loading || awaitingFirstComposition,
                    live: !TaskState(liveState).isTerminal,
                    hasEarlier: hasEarlier,
                    loadingEarlier: loadingEarlier,
                    onLoadEarlier: { Task { await loadEarlierEvents() } },
                    onClose: { withAnimation(.easeOut(duration: 0.2)) { showingChanges = false } }
                )
                .frame(width: RunChangesPanel.width * uiScale)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .background(Surface.content)
        .environment(\.taskCwd, resolvedCwd)
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
            ContinueSheet(followUp: false) { instruction in
                Task { await performResume(instruction: instruction) }
            }
        }
        // A follow-up has no fast path: without an instruction there is nothing
        // to ask for, so the button always opens the sheet.
        .sheet(isPresented: $showingFollowUpSheet) {
            ContinueSheet(followUp: true) { instruction in
                Task { await performResume(instruction: instruction) }
            }
        }
        .alert("Couldn’t update the task. Try again.", isPresented: $showingActionError) {
            Button("OK", role: .cancel) {}
        }
    }

    /// The pane's own column: header, tabs, and the section under them. The
    /// changed-files panel sits beside it rather than inside, so opening it
    /// narrows the trace instead of scrolling with it.
    private var taskColumn: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                if resolvedTaskState == "needs_input", let question = resolvedQuestion {
                    NeedsInputBanner(question: question)
                        .transition(.opacity)
                } else if resolvedTaskState == "blocked" {
                    BlockedBanner(
                        explanation: blockedExplanation,
                        touchedFiles: touchedFilePaths,
                        busy: resumeInFlight || markCompleteInFlight,
                        onWidenScope: {
                            Task { await performResume(instruction: nil, scope: blockedExplanation.suggestedScope) }
                        },
                        onContinue: { Task { await performResume(instruction: nil) } },
                        onMarkCompleted: { Task { await performMarkCompleted() } }
                    )
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
                // The response row itself needs the scroll — it may sit deep in
                // a chapter, well short of the tail `defaultScrollAnchor` lands
                // on. Fires once composition first has something to land on;
                // `hasAppliedInitialFocus` keeps a later recompose from
                // re-scrolling out from under a reader who has moved on.
                .onChange(of: story.blocks) { _, _ in focusResponseIfNeeded(proxy: proxy) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The event this open should treat as the focused response — stable for
    /// the pane's whole lifetime once found, unlike the one-shot scroll below.
    /// Deliberately not gated on `hasAppliedInitialFocus`: that flag exists to
    /// fire the imperative scroll exactly once, but the row's expanded state
    /// and highlight are declarative and must keep pointing at the same event
    /// after the scroll fires, not flip back to unfocused the next render.
    private var initialFocusEventId: Int? {
        guard wantsInitialFocus else { return nil }
        return ActivityStory.responseEvent(in: events)?.id
    }

    /// Scrolls to and marks-attempted exactly once, as soon as composition has
    /// produced something to scroll to. A run with no message event to focus
    /// still counts as attempted — it falls back to the ordinary open behaviour
    /// rather than retrying on every future compose.
    private func focusResponseIfNeeded(proxy: ScrollViewProxy) {
        guard wantsInitialFocus, !hasAppliedInitialFocus, !loading, !composeInFlight else { return }
        hasAppliedInitialFocus = true
        guard let id = ActivityStory.responseEvent(in: events)?.id else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(id, anchor: .center)
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
                queuedFollowUpsSection
                eventContent
                Text("Local trace may contain prompts, tool arguments, file paths, and command output.")
                    .scaledFont(.caption).foregroundStyle(.tertiary)
            }
        }
    }

    /// Work already sent that this run has not reached yet — the queue sits at
    /// the top of the trace so a reader sees what is still coming before they
    /// read what already ran. Hidden entirely while nothing is waiting.
    @ViewBuilder private var queuedFollowUpsSection: some View {
        if let items = task?.queuedFollowUpItems, !items.isEmpty {
            TaskPanel {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6 * uiScale) {
                        Image(systemName: "list.bullet")
                            .font(.system(size: 10 * uiScale, weight: .medium))
                        Text(waitingFollowUpsLabel(items.count))
                            .scaledFont(.caption, weight: .semibold)
                    }
                    .foregroundStyle(.secondary)
                    ForEach(Array(items.enumerated()), id: \.offset) { index, instruction in
                        HStack(alignment: .firstTextBaseline, spacing: 8 * uiScale) {
                            Text("\(index + 1).")
                                .scaledFont(.caption2, design: .monospaced, monospacedDigit: true)
                                .foregroundStyle(.tertiary)
                            Text(instruction)
                                .scaledFont(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    /// One identity line, one muted summary. Run facts are one click away rather
    /// than spending the top of every task on ids the reader rarely needs.
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(resolvedLabel)
                    .scaledFont(.body, weight: .semibold)
                    .lineLimit(1)
                    .help(resolvedLabel)
                // Speaks, because the marker is the only place the state is
                // stated: the chip that used to say the word beside it is gone.
                // It rides the title's tail — the text it describes — reading as
                // the run's status rather than as another control in the row.
                StateMarker(state: state, speaks: true)
                    .help(state.label)
                // No state chip: the marker on the title's tail already carries
                // the state — pulsing while live, tinted and shaped once settled
                // — and spelling it out again cost a chip that resized between
                // states and shoved every chip right of it.
                Spacer(minLength: 8)
                if canResume || canFollowUp {
                    if resumeInFlight {
                        ProgressView().controlSize(.small)
                            .frame(width: 24 * uiScale, height: 24 * uiScale)
                            .help(canFollowUp ? "Sending…" : "Resuming task…")
                    } else if canFollowUp {
                        HeaderTextButton(label: "Follow up") { showingFollowUpSheet = true }
                    } else {
                        HeaderTextButton(label: "Resume") { resumeAction() }
                    }
                }
                if canCancel {
                    if cancelInFlight {
                        ProgressView().controlSize(.small)
                            .frame(width: 24 * uiScale, height: 24 * uiScale)
                            .help("Cancelling task…")
                    } else {
                        HeaderTextButton(label: "Cancel", tint: AnyShapeStyle(.red)) {
                            confirmingCancel = true
                        }
                    }
                }
                IconButton(
                    symbol: "plusminus",
                    label: showingChanges ? "Hide changed files" : "Show changed files",
                    tint: showingChanges ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)
                ) {
                    withAnimation(.easeOut(duration: 0.2)) { showingChanges.toggle() }
                }
                .font(.system(size: 12 * uiScale))
                Menu {
                    taskActionsMenu
                } label: {
                    // A Menu label on macOS drops rotationEffect, so a vertical
                    // kebab has to be drawn as three stacked dots.
                    VStack(spacing: 2.5 * uiScale) {
                        Circle().fill(.secondary).frame(width: 3 * uiScale, height: 3 * uiScale)
                        Circle().fill(.secondary).frame(width: 3 * uiScale, height: 3 * uiScale)
                        Circle().fill(.secondary).frame(width: 3 * uiScale, height: 3 * uiScale)
                    }
                    .frame(width: 24 * uiScale, height: 24 * uiScale)
                    .contentShape(.rect)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .foregroundStyle(.secondary)
                .help("More")
                .accessibilityLabel("More")
            }
            HStack(spacing: 8) {
                // Worker and model share one chip: the list the reader clicked from
                // already named the pair, so here it confirms instead of teaching.
                TaskMetaChip(text: identityLine, label: "Worker and model", full: identityLine) {
                    if let provider = worker?.provider {
                        ProviderLogo(provider: provider, size: 7 * uiScale)
                    } else {
                        Image(systemName: "person")
                            .font(.system(size: 6 * uiScale, weight: .medium))
                    }
                }
                // The reasoning level the run was dispatched with is part of its
                // identity like the model, and absent when the caller set none.
                if let effort = task?.effort, !effort.isEmpty {
                    TaskMetaChip(text: effort, label: "Reasoning effort") {
                        Image(systemName: "brain").font(.system(size: 6 * uiScale, weight: .medium))
                    }
                }
                // Where a run touched files is part of its identity, not a detail: two
                // tasks with the same worker, model and prompt differ only by folder.
                TaskMetaChip(text: resolvedDisplayPath, label: "Folder", full: resolvedCwd, maxChars: 28) {
                    Image(systemName: "folder").font(.system(size: 6 * uiScale, weight: .medium))
                }
                // Work already sent that this run has not reached yet. It changes
                // what the reader is looking at — the task is not over when this
                // run lands — so it belongs beside the run's identity.
                if let waiting = task?.queuedFollowUps, waiting > 0 {
                    TaskMetaChip(text: waitingFollowUpsLabel(waiting), label: "Follow-ups waiting") {
                        Image(systemName: "list.bullet").font(.system(size: 6 * uiScale, weight: .medium))
                    }
                }
            }
        }
    }

    /// The task's remaining actions, grouped like Claude Code's session menu: plain
    /// text rows, thin separators between groups, nothing that needs an icon to be
    /// read. Worker and model live in the header, so they are not repeated here.
    /// A native `Menu` rather than a hand-built popover — the real `NSMenu` chrome
    /// already reads as belonging to macOS (no vibrant-material glitch to work
    /// around), and it gets keyboard navigation and right-click placement for free.
    @ViewBuilder
    private var taskActionsMenu: some View {
        Button("Copy task ID") { copyToPasteboard(taskId) }
        if let sessionId {
            Button("Copy session ID") { copyToPasteboard(sessionId) }
        }
        Button("Copy folder path") { copyToPasteboard(resolvedCwd) }
        if let resumeCommand {
            Button("Copy resume command") { copyToPasteboard(resumeCommand) }
        }
        Divider()
        Button("Open folder") {
            NSWorkspace.shared.open(URL(fileURLWithPath: resolvedCwd))
        }
        Button(resolvedArchivedAt == nil ? "Archive task" : "Restore task") {
            setArchived(taskId, resolvedArchivedAt == nil)
        }
    }

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func waitingFollowUpsLabel(_ count: Int) -> String {
        count == 1 ? "1 follow-up waiting" : "\(count) follow-ups waiting"
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
        [.queued, .pending, .running, .needsInput, .blocked].contains(state)
    }

    /// Resume preconditions on the broker: the run settled without completing.
    /// A waiting task resumes too — that is its "start now".
    private var canResume: Bool {
        [.failed, .cancelled, .blocked, .pending].contains(state)
    }

    /// A finished run has nothing to retry, but its session still holds what the
    /// worker read and decided — so the same call continues it, given an
    /// instruction. The broker refuses one without.
    private var canFollowUp: Bool { state == .completed }

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

    private func performResume(instruction: String?, scope: TaskScope? = nil) async {
        resumeInFlight = true
        defer { resumeInFlight = false }
        guard await store.resumeTask(taskId, instruction: instruction, scope: scope) else {
            showingActionError = true
            return
        }
    }

    private func performMarkCompleted() async {
        markCompleteInFlight = true
        defer { markCompleteInFlight = false }
        guard await store.markTaskCompleted(taskId) else {
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
                    ActivityBlockView(block: block, live: !TaskState(liveState).isTerminal, focusEventId: initialFocusEventId)
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

    /// Plain-language read of a blocked task's completion — falls back to the
    /// sidebar's completion when the full row has not loaded yet.
    private var blockedExplanation: BlockedTaskCopy.Explanation {
        BlockedTaskCopy.explain(completion: task?.completion ?? listItem.completion, currentScope: task?.scope)
    }

    /// Distinct files the worker touched before stopping — the signal a reader
    /// needs to judge whether the work already landed, rather than a guess.
    private var touchedFilePaths: [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for event in events {
            guard event.presentation?.type == "file", let raw = event.presentation?.path else { continue }
            let path = DisplayPath.relative(raw, to: resolvedCwd)
            if seen.insert(path).inserted { ordered.append(path) }
        }
        return ordered
    }

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
        changes = .empty
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
        let cwd = resolvedCwd
        // The pane keeps its identity when the sidebar switches tasks, so a
        // compose that finishes after the switch must not paint the previous
        // task's blocks over the new task's trace.
        let generation = composeGeneration
        Task.detached(priority: .userInitiated) {
            let result = ActivityStory.compose(snapshot)
            let collected = RunChanges.collect(snapshot, cwd: cwd)
            await self.applyComposition(result, changes: collected, generation: generation)
        }
    }

    @MainActor
    private func applyComposition(
        _ comp: ActivityStory.Composition,
        changes collected: RunChangeSet,
        generation: Int
    ) {
        guard generation == composeGeneration else {
            composeInFlight = false
            pendingCompose = false
            return
        }
        story = comp
        changes = collected
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

/// Instruction picker for both continuations: the resume fast path's
/// Option-click, where the field may be left blank and the session picks up
/// as-is, and a follow-up on finished work, where the instruction is the whole
/// job and there is nothing to send without one.
private struct ContinueSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var instruction = ""
    @FocusState private var instructionFocused: Bool
    /// Return can fire both the field's submit and the default-action shortcut;
    /// the flag keeps a double trigger from resuming twice.
    @State private var submitted = false
    let followUp: Bool
    let onSubmit: (String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(followUp ? "Follow up" : "Resume task").font(.title3.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(followUp ? "Send" : "Resume") { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(followUp && trimmedInstruction == nil)
            }
            .padding(20)
            Divider()
            TextField(
                followUp ? "What should the worker do next?" : "Instruction for the worker (optional)",
                text: $instruction,
                axis: .vertical
            )
                .lineLimit(3...8)
                .textFieldStyle(.plain)
                .focused($instructionFocused)
                .onSubmit(submit)
                .padding(20)
            Text(followUp
                ? "The worker still has everything it read and worked out on this task, so say only what changes."
                : "The worker sees this at the head of the continued session. Leave it blank to continue as-is.")
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
        let value = trimmedInstruction
        if followUp, value == nil { return }
        submitted = true
        dismiss()
        onSubmit(value)
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
            AccessibilityNotification.Announcement("Worker needs input").post()
        }
    }
}

/// Plain-language read of why a task is blocked, derived from its completion.
/// A worker's own `INTER_BLOCKED` report carries one of three codes
/// (`permission_denied`, `needs_authority`, `worker_error`); the broker adds a
/// fourth, `unverified`, when a run ends with no report at all. Those four are
/// the only cases mapped — anything else falls back to the generic line.
enum BlockedTaskCopy {
    struct Explanation: Equatable {
        var headline: String
        /// The worker's own `completion.reason`, kept verbatim but never shown
        /// as the primary explanation — some reasons match no known pattern,
        /// and even the ones that do are still useful for debugging.
        var rawReason: String?
        var deniedPaths: [String]
        var suggestedScope: TaskScope?
    }

    static func explain(completion: TaskCompletion?, currentScope: TaskScope?) -> Explanation {
        guard let completion else {
            return Explanation(
                headline: "The run stopped without settling, and Inter has no record of why.",
                rawReason: nil, deniedPaths: [], suggestedScope: nil
            )
        }
        let reason = completion.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawReason = (reason?.isEmpty == false) ? reason : nil
        switch completion.code {
        case "permission_denied":
            let suggested = completion.suggestedScope
            let denied = deniedPaths(current: currentScope, suggested: suggested)
            let headline = denied.isEmpty
                ? "The worker was stopped before it could reach a file or folder it needed."
                : "The worker was stopped before it could reach \(list(denied))."
            return Explanation(headline: headline, rawReason: rawReason, deniedPaths: denied, suggestedScope: suggested)
        case "needs_authority":
            return Explanation(
                headline: "The worker stopped because it needed a decision it couldn’t make on its own.",
                rawReason: rawReason, deniedPaths: [], suggestedScope: nil
            )
        case "unverified":
            // The broker's own reason string here is fixed internal wording
            // ("worker exited without an Inter completion marker") — the
            // headline already says the same thing in plain terms, so the raw
            // string adds nothing and is left out.
            return Explanation(
                headline: "The worker stopped talking before it said whether the work was done.",
                rawReason: nil, deniedPaths: [], suggestedScope: nil
            )
        default:
            if let reason, reason.range(of: "broker restarted", options: .caseInsensitive) != nil {
                return Explanation(
                    headline: "The run was interrupted when Inter restarted.",
                    rawReason: rawReason, deniedPaths: [], suggestedScope: nil
                )
            }
            return Explanation(
                headline: "Something interrupted the worker before it could finish.",
                rawReason: rawReason, deniedPaths: [], suggestedScope: nil
            )
        }
    }

    private static func deniedPaths(current: TaskScope?, suggested: TaskScope?) -> [String] {
        guard let suggested else { return [] }
        let currentWrite = Set(current?.write ?? [])
        let newWrite = suggested.write.filter { !currentWrite.contains($0) }
        if !newWrite.isEmpty { return newWrite }
        let currentRead = Set(current?.read ?? [])
        return suggested.read.filter { !currentRead.contains($0) }
    }

    private static func list(_ paths: [String]) -> String {
        paths.count == 1 ? paths[0] : paths.joined(separator: ", ")
    }
}

private struct BlockedBanner: View {
    let explanation: BlockedTaskCopy.Explanation
    let touchedFiles: [String]
    /// Resume or mark-completed in flight — the row swaps to a spinner so the
    /// task's settle reads as busy instead of dead.
    let busy: Bool
    let onWidenScope: () -> Void
    let onContinue: () -> Void
    let onMarkCompleted: () -> Void

    @State private var showingRawReason = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AccentRule(color: .orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(explanation.headline).scaledFont(.callout, weight: .semibold)
                    Text(fileSummary).scaledFont(.caption).foregroundStyle(.secondary)
                    if let rawReason = explanation.rawReason {
                        CollapsibleSection(isExpanded: $showingRawReason) {
                            Text("Technical detail").scaledFont(.caption, weight: .medium).foregroundStyle(.secondary)
                        } trailing: {
                            CopyIconButton(text: rawReason, label: "Copy technical detail")
                        }
                        if showingRawReason {
                            Text(rawReason)
                                .scaledFont(.caption, design: .monospaced)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    HStack(spacing: 8) {
                        if explanation.suggestedScope != nil {
                            Button("Continue with wider access", action: onWidenScope)
                                .buttonStyle(.borderedProminent).controlSize(.small)
                            Button("Continue as-is", action: onContinue)
                                .buttonStyle(.bordered).controlSize(.small)
                        } else {
                            Button("Continue as-is", action: onContinue)
                                .buttonStyle(.borderedProminent).controlSize(.small)
                        }
                        Button("Mark as completed", action: onMarkCompleted)
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            }
        }
        .padding(12)
        .onAppear {
            AccessibilityNotification.Announcement("Task blocked").post()
        }
    }

    private var fileSummary: String {
        switch touchedFiles.count {
        case 0: "It hadn’t changed any files when it stopped."
        case 1: "It changed 1 file before stopping: \(touchedFiles[0])."
        case 2...3: "It changed \(touchedFiles.count) files before stopping: \(touchedFiles.joined(separator: ", "))."
        default: "It changed \(touchedFiles.count) files before stopping, including \(touchedFiles.prefix(3).joined(separator: ", "))."
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
    /// The run's response event, on the one open where it should be the
    /// focus. Only a chapter can hold it — the response is a worker message,
    /// never a signal, receipt, or handoff row.
    var focusEventId: Int? = nil

    var body: some View {
        switch block {
        case .chapter(_, let rows):
            ActivityChapterCard(rows: rows, muted: false, live: live, focusEventId: focusEventId)
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
    var focusEventId: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row {
                case .work(let event):
                    ActivityWorkRow(event: event, muted: muted, live: live, initiallyExpanded: event.id == focusEventId)
                        .id(event.id)
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
    @State private var showingRawDetails: Bool
    /// Whether this row opened already expanded because it is the run's
    /// focused response — set once, at construction, from the parent's
    /// choice of which row to land on. The highlight below reads off this
    /// together with the row's own (user-toggleable) `showingRawDetails`, so
    /// collapsing the row once is enough to drop the highlight for good —
    /// nothing here re-asserts it after that.
    private let isFocusTarget: Bool
    /// Whether the landing highlight has already faded out.
    @State private var focusFaded = false
    @Environment(\.taskCwd) private var taskCwd
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(event: TaskEventSnapshot, muted: Bool = false, live: Bool = false, initiallyExpanded: Bool = false) {
        self.event = event
        self.muted = muted
        self.live = live
        isFocusTarget = initiallyExpanded
        _showingRawDetails = State(initialValue: initiallyExpanded)
    }

    /// The verb that opens the row, when the title is a known tool.
    private var verb: String? { ToolIcon.verb(for: event, live: live) }

    /// Lifecycle and error rows narrate the app to itself — a hold clearing,
    /// a worker starting — rather than content the worker produced. They
    /// collapse to one line instead of a title over a detail line.
    private var isNotice: Bool { event.kind == "lifecycle" || event.kind == "error" }

    /// A notice with nothing to add past its own name — "Resumed", "Started",
    /// "Session Reused" — has no second half to put on the line. Shown at
    /// full row weight it competes with the content around it for no reason;
    /// this is the step past one line, down to a bare word a reader can skip.
    private var isBareNotice: Bool { isNotice && (event.detail?.isEmpty ?? true) }

    var body: some View {
        if isBareNotice {
            marker
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .center, spacing: 8) {
                    if isQuote {
                        quoteContent
                    } else if isNotice {
                        noticeContent
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
                if let presentation = blockPresentation, !isNotice {
                    TaskEventPresentationView(presentation: presentation, plan: todoPlan)
                }
                if showingRawDetails {
                    EventExpansionView(event: event).padding(.top, 3).transition(.opacity)
                }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, isFocused ? 8 : 0)
            .background(isFocused ? Surface.selection : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small))
            .task { await fadeFocusHighlightIfNeeded() }
        }
    }

    /// The word alone, closer to a separator than a row: no accent, no
    /// chevron, no timestamp — those all belong to a row worth stopping on,
    /// and a bare notice never offers an expansion (`EventExpansion` has no
    /// second reading for a lifecycle event with no detail and no payload
    /// worth opening), so there is nothing behind it to reach for anyway.
    private var marker: some View {
        Text(event.title)
            .scaledFont(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .padding(.vertical, 2)
    }

    /// Title and detail on one line, a step quieter than a worker message or
    /// a file row on the type ladder — this is the app talking about itself,
    /// not something the worker did. One size for the whole line; hierarchy
    /// comes from the title's weight and, on failure, its color — not from
    /// running a bigger font next to a smaller one. This row is a record of
    /// what happened, not a signal demanding attention, so the detail stays
    /// secondary even when the title reads red; `ActivitySignalCard` is
    /// where a genuine error tints its own detail. The title never
    /// truncates; a long detail loses its tail first.
    @ViewBuilder private var noticeContent: some View {
        HStack(spacing: 4) {
            Text(event.title)
                .scaledFont(.caption2, weight: .semibold)
                .foregroundStyle(event.phase == "failed" ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            if let detail = event.detail, !detail.isEmpty {
                Text("· \(detail)")
                    .scaledFont(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .textSelection(.enabled)
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

    /// The run's response, read the way the reader already reads "the
    /// current row" elsewhere in the app (`Surface.selection`) — tied to
    /// `showingRawDetails` rather than `isFocusTarget` alone, so collapsing
    /// the row drops the highlight along with it, the same action that stops
    /// the trace fighting the operator's own scroll. `focusFaded` ends the
    /// highlight on its own after the pane lands.
    private var isFocused: Bool { isFocusTarget && showingRawDetails && !focusFaded }

    /// The landing highlight marks where the pane arrived, not a selection
    /// the reader made, so it lets go a moment later instead of staying as a
    /// permanent fill behind the run's closing answer.
    private func fadeFocusHighlightIfNeeded() async {
        guard isFocusTarget, !focusFaded else { return }
        try? await Task.sleep(for: .seconds(1.5))
        guard !Task.isCancelled, isFocusTarget, !focusFaded else { return }
        if reduceMotion {
            focusFaded = true
        } else {
            withAnimation(.easeOut(duration: 0.4)) { focusFaded = true }
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

    /// The parsed plan for a todo row, so the collapsed summary reads its
    /// counts from the same list the expanded checklist renders.
    private var todoPlan: TodoPlan? {
        guard event.presentation?.type == "todo" else { return nil }
        return event.rawText.flatMap(TodoPlan.init(rawEvent:))
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
                if let subject = presentation.type == "file"
                    ? presentation.path.map({ DisplayPath.relative($0, to: taskCwd) })
                    : presentation.command {
                    Text(subject).scaledFont(.caption, design: .monospaced).foregroundStyle(subjectTint)
                        .lineLimit(1)
                        .truncationMode(presentation.type == "file" ? .middle : .tail)
                }
                ForEach(chips, id: \.self) { chip in
                    ActivityChip(text: chip)
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

/// A pill beside a row's subject — a change summary, an exit code, a patch's
/// signed line count. One step below the subject on the type ladder: the
/// subject is what the row is naming, the badge is what became of it. A
/// signed tally (`+6 −2`, the broker's own format for a patch's line count)
/// reads in the same colors as the diff it counts; anything else is plain.
private struct ActivityChip: View {
    let text: String

    var body: some View {
        content
            .scaledFont(.caption2, weight: .medium, design: .monospaced)
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
    }

    @ViewBuilder private var content: some View {
        if let tally = ActivityChip.tally(text) {
            Text("+\(tally.added)").foregroundColor(DiffTint.added)
                + Text(" ")
                + Text("−\(tally.removed)").foregroundColor(DiffTint.removed)
        } else {
            Text(text)
        }
    }

    private static func tally(_ text: String) -> (added: Int, removed: Int)? {
        let parts = text.split(separator: " ")
        guard parts.count == 2,
              parts[0].hasPrefix("+"), let added = Int(parts[0].dropFirst()),
              parts[1].hasPrefix("−"), let removed = Int(parts[1].dropFirst())
        else { return nil }
        return (added, removed)
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
/// tinted 2pt rule on the page's edge plus the line itself, title and detail
/// merged onto one line a step quieter than a worker row — this is the app
/// narrating itself, not work the reader needs to read closely. A glyph
/// beside the rule would say the same thing a third time: the rule's tint
/// already marks severity, and the title already names what happened. An
/// error additionally tints its own line red rather than leaving that to the
/// hairline alone, since a failure is the one severity worth reading at a
/// glance without following the rule to the title.
private struct ActivitySignalCard: View {
    let event: TaskEventSnapshot

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            AccentRule(color: tint)
                .accessibilityHidden(true)
            HStack(spacing: 4) {
                Text(event.title)
                    .scaledFont(.caption2, weight: .semibold)
                    .foregroundStyle(severity == "error" ? AnyShapeStyle(tint) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if let text = event.presentation?.text ?? event.detail, !text.isEmpty {
                    Text("· \(text)")
                        .scaledFont(.caption2)
                        .foregroundStyle(severity == "error" ? AnyShapeStyle(tint.opacity(0.75)) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .textSelection(.enabled)
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
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(alignment: .center, spacing: 9) {
                    AccentRule()
                        .accessibilityHidden(true)
                    HStack(spacing: 4) {
                        Text("Handed off")
                            .scaledFont(.caption2, weight: .semibold)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                        Text("· \(summary)")
                            .scaledFont(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 12)
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")

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
    /// The parsed plan, when the raw payload holds one — the collapsed line
    /// counts from the same list as the expanded checklist, so the two never
    /// disagree about how much of the work is done.
    var plan: TodoPlan? = nil

    @Environment(\.uiScale) private var uiScale
    @Environment(\.taskCwd) private var taskCwd

    @ViewBuilder var body: some View {
        switch presentation.type {
        case "file":
            HStack(spacing: 8) {
                if let path = presentation.path {
                    Text(DisplayPath.relative(path, to: taskCwd))
                        .scaledFont(.caption, design: .monospaced).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                ForEach([presentation.change, presentation.outcome].compactMap { $0 }, id: \.self) { chip in
                    ActivityChip(text: chip)
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
            let done = plan?.completedCount ?? presentation.completed ?? 0
            let total = plan?.total ?? presentation.total ?? 0
            let active = plan?.activeText ?? presentation.text
            HStack(spacing: 8) {
                if total > 0 {
                    ProgressView(
                        value: Double(done),
                        total: Double(total)
                    )
                    .frame(width: 72 * uiScale)
                    Text("\(done) of \(total) complete")
                        .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.secondary)
                } else {
                    // No denominator — a full bar with a zero total would lie.
                    Text(done > 0 ? "\(done) done" : "No todo items yet")
                        .scaledFont(.caption, monospacedDigit: true).foregroundStyle(.secondary)
                }
                if let active {
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
        HStack(spacing: 1.5 * uiScale) {
            icon
            Text(displayText)
                .scaledFont(.caption2, design: .monospaced)
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        // The text is already on the ladder's bottom rung, so the chip's size is
        // set by what surrounds it: padding, the gap, and the icon.
        .padding(.horizontal, 3 * uiScale)
        .padding(.vertical, 1 * uiScale)
        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: 5))
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

/// A top-level header action, rendered as text rather than a glyph — a button
/// that says "Cancel" needs no icon to explain it.
private struct HeaderTextButton: View {
    let label: String
    var tint: AnyShapeStyle = AnyShapeStyle(.secondary)
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .scaledFont(.caption, weight: .medium)
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .accessibilityLabel(label)
    }
}
