import Foundation

/// A trace retold as blocks instead of a dot-per-event timeline: chapters of
/// work, one-line reasoning pulses, signal strips, and a closing receipt. Pure,
/// so the retelling rules are testable without a view.
enum ActivityStory {
    struct Composition: Sendable {
        let blocks: [ActivityBlock]
        let technical: [TaskEventSnapshot]
    }

    /// Consecutive `Thinking` progress events collapsed to one line. `detail`
    /// is the last event's counter, so the line always shows the final tally
    /// — unless the provider's reasoning events carry prose instead of a
    /// counter, in which case `detail` falls back to `"Thinking"` and
    /// `updates`/`seconds` tell the story instead.
    struct ReasoningPulse: Hashable, Sendable {
        let id: Int
        let detail: String
        let updates: Int
        let seconds: Int?
    }

    static func compose(_ rawEvents: [TaskEventSnapshot]) -> Composition {
        let events = foldActions(rawEvents)
        let boundaries = events.enumerated().filter { $0.element.title == "Handed off to another profile" }
        if boundaries.isEmpty { return composeFlat(events) }
        return composeWithHandoffs(events, boundaries: boundaries)
    }

    /// The current compose loop, unchanged. Extracted so every run — the
    /// original and each handoff leg — goes through the same shaping rules.
    private static func composeFlat(_ events: [TaskEventSnapshot]) -> Composition {
        var blocks: [ActivityBlock] = []
        var technical: [TaskEventSnapshot] = []
        var chapter: [ChapterRow] = []
        var pulse: [TaskEventSnapshot] = []
        let receiptID = events.last { $0.kind == "usage" }?.id
        let stallID = events.last { isStalledHeartbeat($0) }?.id
        var thinkingTokens = 0
        var receiptIndex: Int?

        func flushChapter() {
            guard !chapter.isEmpty else { return }
            blocks.append(.chapter(id: chapter[0].id, rows: chapter))
            chapter = []
        }
        func flushPulse() {
            guard let first = pulse.first, let last = pulse.last else { return }
            thinkingTokens += pulse.reduce(0) { $0 + ($1.presentation?.tokensThinking ?? 0) }
            let rawDetail = last.detail ?? "Thinking"
            // pi flushes the prose of the thought itself on every tick, roughly
            // once a second — a run of those collapses into one pulse whose
            // last detail would otherwise be a full paragraph of raw reasoning
            // on what is meant to be a single quiet line. Only a detail shaped
            // like a counter (claude's `~5.2k tokens so far`) is safe to show;
            // anything else falls back to "Thinking" and lets `updates` and
            // `seconds`, already rendered alongside it, carry the summary.
            let detail = isCounter(rawDetail) ? rawDetail.replacingOccurrences(of: " so far", with: "") : "Thinking"
            let line = ReasoningPulse(
                id: first.id,
                detail: detail,
                updates: pulse.count,
                seconds: seconds(from: first.createdAt, to: last.createdAt)
            )
            if chapter.isEmpty { blocks.append(.reasoning(line)) } else { chapter.append(.reasoning(line)) }
            pulse = []
        }

        for event in events {
            if isThinkingPulse(event) {
                pulse.append(event)
                continue
            }
            if isTechnical(event), event.id != receiptID {
                technical.append(event)
                continue
            }
            flushPulse()
            if isStalledHeartbeat(event) {
                if event.id == stallID {
                    flushChapter()
                    blocks.append(.signal(event))
                } else {
                    technical.append(event)
                }
                continue
            }
            if event.kind == "usage" {
                if event.id == receiptID {
                    flushChapter()
                    receiptIndex = blocks.count
                    blocks.append(.receipt(event, thinkingTokens: event.presentation?.tokensThinking ?? 0))
                } else {
                    technical.append(event)
                }
                continue
            }
            if isSignal(event) {
                flushChapter()
                blocks.append(.signal(event))
                continue
            }
            if case .work(let last)? = chapter.last, sameShape(last, event) {
                chapter[chapter.count - 1] = .work(event)
            } else {
                chapter.append(.work(event))
            }
        }
        flushPulse()
        flushChapter()
        if let index = receiptIndex, case .receipt(let event, let stamped) = blocks[index],
           thinkingTokens > stamped {
            blocks[index] = .receipt(event, thinkingTokens: thinkingTokens)
        }
        return Composition(blocks: blocks, technical: technical)
    }

    /// Splits the stream at every `handed_off` event. Everything before the
    /// last boundary becomes a single collapsible row; the tail is the current
    /// run and renders as it would for a task that was never handed off.
    private static func composeWithHandoffs(
        _ events: [TaskEventSnapshot],
        boundaries: [(Int, TaskEventSnapshot)]
    ) -> Composition {
        let hops = boundaries.map { Hop.from($0.1.detail) }
        let chain = Hop.chain(hops)
        var start = 0
        var runs: [(hop: Hop?, events: [TaskEventSnapshot])] = []
        for (idx, _) in boundaries {
            runs.append((hop: nil, events: Array(events[start..<idx])))
            start = idx + 1
        }
        runs.append((hop: nil, events: Array(events[start...])))
        // Tag each earlier run with the handoff that closed it.
        for i in 0..<(runs.count - 1) {
            runs[i].hop = hops[i]
        }
        let composed = runs.map { composeFlat($0.events) }
        let earlier = zip(runs.dropLast(), composed.dropLast()).map { run, comp in
            HandoffRun(endedBy: run.hop, blocks: comp.blocks)
        }
        let current = composed.last?.blocks ?? []
        let hiddenEventCount = runs.dropLast().reduce(0) { $0 + $1.events.count }
        let allTechnical = composed.flatMap(\.technical)
        var blocks: [ActivityBlock] = [.handoff(HandoffBoundary(
            chain: chain, earlierRuns: earlier, hiddenEventCount: hiddenEventCount
        ))]
        blocks.append(contentsOf: current)
        return Composition(blocks: blocks, technical: allTechnical)
    }

    /// Claude streams a cumulative thinking-token counter; each tick is one
    /// event. Providers whose reasoning events carry prose keep their rows.
    private static func isThinkingPulse(_ event: TaskEventSnapshot) -> Bool {
        event.kind == "reasoning" && event.title == "Thinking"
    }

    /// A counter reads as a number (with an optional `~` and `k`/`m` scale)
    /// followed by the word `tokens`, optionally trailing `so far` — never a
    /// sentence. Matching the shape, rather than gating on length, is the
    /// part that survives a provider we haven't seen yet: a short detail can
    /// still be prose (a one-word thought), and a long one could in theory be
    /// a verbose counter, so counting characters would get both wrong.
    private static let counterPattern = try! NSRegularExpression(
        pattern: #"^~?[\d,.]+[kKmM]?\s+tokens(\s+so\s+far)?$"#
    )

    private static func isCounter(_ detail: String) -> Bool {
        let range = NSRange(detail.startIndex..., in: detail)
        return counterPattern.firstMatch(in: detail, range: range) != nil
    }

    private static func isSignal(_ event: TaskEventSnapshot) -> Bool {
        if event.presentation?.type == "signal" { return true }
        if event.source == "broker", event.kind == "error" { return true }
        if event.title == "Worker needs input" { return true }
        if event.title == "Event capture limit reached" { return true }
        return isStalledHeartbeat(event)
    }

    static func isStalledHeartbeat(_ event: TaskEventSnapshot) -> Bool {
        event.title == "Heartbeat" && (event.detail?.hasPrefix("No agent event") ?? false)
    }

    /// Two events describe the same action when the row's identity — kind,
    /// title, and detail line — is identical. Phase, timestamp, and settled
    /// presentation state (an exit code arriving on the later event) may
    /// differ; the later event wins. Used only for providers that send no
    /// action id; `foldActions` handles the rest.
    private static func sameShape(_ a: TaskEventSnapshot, _ b: TaskEventSnapshot) -> Bool {
        a.actionId == nil && b.actionId == nil
            && a.kind == b.kind && a.title == b.title && a.detail == b.detail
    }

    /// One tool call reaches the trace up to four times: the agent's own echo
    /// of the call, a pre-hook, a post-hook, and the result — and the calls
    /// interleave, so adjacency alone never catches them. Every provider tags
    /// the run with one id, so fold each id to where it first appeared and
    /// carry the settled event forward: the later one knows the exit state.
    static func foldActions(_ events: [TaskEventSnapshot]) -> [TaskEventSnapshot] {
        var slot: [String: Int] = [:]
        var folded: [TaskEventSnapshot] = []
        for event in events {
            guard let action = event.actionId, !action.isEmpty else {
                folded.append(event)
                continue
            }
            if let index = slot[action] {
                folded[index] = settle(folded[index], with: event)
                continue
            }
            // A result never opens a row of its own — it only reports on a call.
            // One that arrives with nothing to report on stays where it fell.
            if isTechnical(event) {
                folded.append(event)
                continue
            }
            slot[action] = folded.count
            folded.append(event)
        }
        return folded
    }

    /// The row keeps the first event's identity and clock — when the action
    /// started — and takes everything the later event knows better. A failure
    /// seen anywhere in the run is the outcome, even if a hook reports after
    /// it.
    private static func settle(
        _ first: TaskEventSnapshot,
        with later: TaskEventSnapshot
    ) -> TaskEventSnapshot {
        // A folded-away result contributes its outcome and its failure, nothing
        // else: the call already named the tool, the path, and the arguments.
        if later.minor == true {
            var merged = first
            if let outcome = later.presentation?.outcome, !restates(merged.detail, outcome) {
                if merged.presentation != nil { merged.presentation?.outcome = outcome }
                else { merged.detail = [merged.detail, outcome].compactMap { $0 }.joined(separator: " · ") }
            }
            if later.phase == "failed" { merged.phase = "failed" }
            return merged
        }
        // pi and opencode close a call with an event that carries no
        // arguments at all — a bare `{ type: "tool", outcome: … }` — because
        // the provider's own end-of-call message never repeats what the call
        // was for. That closing event still isn't `minor`, so without this
        // check it would win outright below and the row would lose the path
        // or command the opening event named, collapsing a Read/Bash row
        // into a bare "tool" row with nothing to show beside the title. A
        // closing event that knows only the outcome must not overwrite an
        // opening event that knows the subject; it only gets to add the
        // outcome to it.
        if isOutcomeOnly(later.presentation), isSubject(first.presentation) {
            var merged = first
            if let outcome = later.presentation?.outcome {
                merged.presentation?.outcome = outcome
            }
            if later.phase == "failed" { merged.phase = "failed" }
            return merged
        }
        var merged = later
        merged.id = first.id
        merged.createdAt = first.createdAt
        if merged.detail == nil { merged.detail = first.detail }
        if merged.presentation == nil { merged.presentation = first.presentation }
        if merged.rawText == nil { merged.rawText = first.rawText }
        // The result can land before the closing hook; its outcome outlives it.
        if merged.presentation?.outcome == nil, let outcome = first.presentation?.outcome {
            merged.presentation?.outcome = outcome
        }
        if first.phase == "failed" { merged.phase = "failed" }
        return merged
    }

    /// A presentation that says nothing but how the call went: type `"tool"`
    /// and every field besides `outcome` empty. This is what a
    /// `tool_execution_end` becomes when the provider sends no result
    /// arguments — pi sends `args: null` outright.
    private static func isOutcomeOnly(_ presentation: TaskEventPresentationSnapshot?) -> Bool {
        guard let presentation, presentation.type == "tool" else { return false }
        return presentation.path == nil && presentation.change == nil && presentation.command == nil
            && presentation.status == nil && presentation.exitCode == nil && presentation.text == nil
            && presentation.completed == nil && presentation.total == nil && presentation.costUsd == nil
            && presentation.tokensIn == nil && presentation.tokensOut == nil && presentation.tokensCached == nil
            && presentation.tokensThinking == nil && presentation.turns == nil && presentation.durationMs == nil
            && presentation.level == nil
    }

    /// A presentation that names what the call was on: a `"file"` with a
    /// path, or a `"command"` with a command line. These are the two shapes
    /// `ActivityWorkRow.inlineContent` draws a chip for.
    private static func isSubject(_ presentation: TaskEventPresentationSnapshot?) -> Bool {
        guard let presentation else { return false }
        if presentation.type == "file" { return presentation.path != nil }
        if presentation.type == "command" { return presentation.command != nil }
        return false
    }

    /// A failed call is reported twice — the hook names the error and the
    /// result repeats it — so an outcome the row already says earns no chip.
    /// Both sides may be truncated, so the comparison is on a leading run of
    /// the outcome, long enough that a short one like `no output` can't match
    /// by accident.
    private static func restates(_ detail: String?, _ outcome: String) -> Bool {
        guard let detail else { return false }
        let core = outcome
            .replacingOccurrences(of: "Error: ", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "… "))
        guard core.count >= 16 else { return false }
        return detail.contains(core.prefix(40))
    }

    /// Plumbing worth keeping reachable but not worth a row. The broker marks
    /// its own protocol echoes with `minor`; the title lists only cover events
    /// stored before that flag existed. An unrecognized raw event stays
    /// visible — hiding a new provider's events would bury the only trace of
    /// them.
    private static let plumbing: Set<String> = [
        "Step Start", "Step Finish", "Tool result",
        "Hook Started", "Hook Response", "Status", "Commands Changed",
    ]

    /// Bookkeeping the run states elsewhere: the worker and its session are named
    /// in the header, and archiving is something the reader did, not the worker.
    private static let bookkeeping: Set<String> = [
        "Task queued", "Worker started", "Worker spawned", "Task completed",
        "Session Captured", "Archived", "Handoff brief built",
    ]

    private static func isTechnical(_ event: TaskEventSnapshot) -> Bool {
        if event.minor == true { return !isStalledHeartbeat(event) }
        if event.kind == "raw" { return plumbing.contains(event.title) }
        if event.title == "Heartbeat" { return !isStalledHeartbeat(event) }
        // A tool row with neither a detail nor a presentation says only that some
        // call happened — a progress ping from a run recorded before the broker
        // started marking them. The title alone is not a row.
        if event.kind == "tool", event.detail == nil, event.presentation == nil { return true }
        return bookkeeping.contains(event.title)
    }

    private static func seconds(from start: String, to end: String) -> Int? {
        guard let from = EventClock.date(start), let to = EventClock.date(end) else { return nil }
        let value = Int(to.timeIntervalSince(from).rounded())
        return value > 0 ? value : nil
    }
}

enum ActivityBlock: Identifiable, Equatable, Sendable {
    case chapter(id: Int, rows: [ChapterRow])
    case reasoning(ActivityStory.ReasoningPulse)
    case signal(TaskEventSnapshot)
    case receipt(TaskEventSnapshot, thinkingTokens: Int)
    case handoff(HandoffBoundary)

    var id: Int {
        switch self {
        case .chapter(let id, _): id
        case .reasoning(let pulse): pulse.id
        case .signal(let event): event.id
        case .receipt(let event, _): event.id
        case .handoff: 0
        }
    }
}

/// One `from → to` pair parsed from a `handed_off` detail string like
/// `opencode → codex`. Both sides are mapped to their display labels, and the
/// raw profile ids stay reachable. When the arrow or the prefix is missing the
/// hop degrades to the raw string without crashing.
struct Hop: Equatable, Sendable {
    let fromId: String
    let toId: String
    let fromLabel: String
    let toLabel: String
    let display: String

    /// Displays the hop readably: `OpenCode → Codex`.
    var label: String { "\(fromLabel) → \(toLabel)" }

    fileprivate static func from(_ detail: String?) -> Hop {
        guard let detail, let arrow = detail.range(of: " → ") else {
            let fallback = detail ?? "Unknown profile"
            return Hop(fromId: fallback, toId: fallback, fromLabel: fallback, toLabel: fallback, display: fallback)
        }
        let from = String(detail[..<arrow.lowerBound])
        let to = String(detail[arrow.upperBound...])
        let fromLabel = Provider(rawValue: from)?.label ?? from
        let toLabel = Provider(rawValue: to)?.label ?? to
        return Hop(fromId: from, toId: to, fromLabel: fromLabel, toLabel: toLabel,
                   display: "\(fromLabel) → \(toLabel)")
    }

    /// Chains consecutive hops: `OpenCode → Codex → Antigravity → Pi`.
    fileprivate static func chain(_ hops: [Hop]) -> String {
        guard let first = hops.first else { return "" }
        let tos = hops.map(\.toLabel)
        return "\(first.fromLabel) → \(tos.joined(separator: " → "))"
    }
}

/// One run — the original or a handoff leg — and the handoff that closed it.
struct HandoffRun: Equatable, Sendable {
    let endedBy: Hop?
    let blocks: [ActivityBlock]
}

/// Everything the handoff row needs to render itself collapsed and expanded.
struct HandoffBoundary: Equatable, Sendable {
    let chain: String
    let earlierRuns: [HandoffRun]
    /// Raw events hidden, not blocks — the row promises the user a count of
    /// what happened, and blocks are already-collapsed chapters.
    let hiddenEventCount: Int
}

/// What a chapter is made of: the work, and the thinking that happened between
/// it. A pulse is a line inside the run, not a break in it.
enum ChapterRow: Identifiable, Equatable, Sendable {
    case work(TaskEventSnapshot)
    case reasoning(ActivityStory.ReasoningPulse)

    var id: Int {
        switch self {
        case .work(let event): event.id
        case .reasoning(let pulse): pulse.id
        }
    }

    var isWork: Bool {
        if case .work = self { return true }
        return false
    }
}

enum EventClock {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()

    static func date(_ value: String) -> Date? {
        fractional.date(from: value) ?? standard.date(from: value)
    }

    static func time(_ value: String) -> String {
        guard let date = date(value) else { return value }
        return date.formatted(date: .omitted, time: .standard)
    }
}

/// Number formatting for receipt stats, matching the broker's compact style.
enum ActivityFormat {
    static func count(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 10_000 { return "\(Int((Double(value) / 1_000).rounded()))k" }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return String(value)
    }

    static func cost(_ value: Double) -> String {
        value >= 0.01 || value == 0 ? String(format: "$%.2f", value) : String(format: "$%.4f", value)
    }

    static func duration(_ ms: Int) -> String {
        if ms < 1_000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1_000
        if seconds < 60 {
            return seconds < 10 ? String(format: "%.1fs", seconds) : "\(Int(seconds.rounded()))s"
        }
        let minutes = Int(seconds) / 60
        if minutes < 60 { return "\(minutes)m \(Int(seconds) % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}
