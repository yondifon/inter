import Foundation

/// A trace retold as blocks instead of a dot-per-event timeline: chapters of
/// work, one-line reasoning pulses, signal strips, and a closing receipt. Pure,
/// so the retelling rules are testable without a view.
enum ActivityStory {
    struct Composition {
        let blocks: [ActivityBlock]
        let technical: [TaskEventSnapshot]
    }

    /// Consecutive `Thinking` progress events collapsed to one line. `detail`
    /// is the last event's counter, so the line always shows the final tally.
    struct ReasoningPulse: Hashable {
        let id: Int
        let detail: String
        let updates: Int
        let seconds: Int?
    }

    static func compose(_ rawEvents: [TaskEventSnapshot]) -> Composition {
        let events = foldActions(rawEvents)
        var blocks: [ActivityBlock] = []
        var technical: [TaskEventSnapshot] = []
        var chapter: [TaskEventSnapshot] = []
        var pulse: [TaskEventSnapshot] = []
        let receiptID = events.last { $0.kind == "usage" }?.id
        let stallID = events.last { isStalledHeartbeat($0) }?.id
        // Reasoning tokens are only ever reported as a per-turn counter that
        // restarts, so the run total has to be accumulated from the deltas and
        // stamped on the receipt once every pulse has been counted.
        var thinkingTokens = 0
        var receiptIndex: Int?

        func flushChapter() {
            guard !chapter.isEmpty else { return }
            blocks.append(.chapter(id: chapter[0].id, events: chapter))
            chapter = []
        }
        func flushPulse() {
            guard let first = pulse.first, let last = pulse.last else { return }
            thinkingTokens += pulse.reduce(0) { $0 + ($1.presentation?.tokensThinking ?? 0) }
            blocks.append(.reasoning(ReasoningPulse(
                id: first.id,
                detail: (last.detail ?? "Thinking").replacingOccurrences(of: " so far", with: ""),
                updates: pulse.count,
                seconds: seconds(from: first.createdAt, to: last.createdAt)
            )))
            pulse = []
        }

        for event in events {
            if isThinkingPulse(event) {
                flushChapter()
                pulse.append(event)
                continue
            }
            flushPulse()
            if isStalledHeartbeat(event) {
                // A stall is a live condition, not history. Only the newest
                // tick earns a strip; the earlier ones repeat the same fact
                // with a smaller number, and a stall the worker already broke
                // out of is not worth interrupting the trace for.
                if event.id == stallID {
                    flushChapter()
                    blocks.append(.signal(event))
                } else {
                    technical.append(event)
                }
                continue
            }
            if event.kind == "usage" {
                // Only the final usage event settles the run; earlier per-turn
                // receipts repeat the same shape with smaller numbers.
                if event.id == receiptID {
                    flushChapter()
                    receiptIndex = blocks.count
                    blocks.append(.receipt(event, thinkingTokens: 0))
                } else {
                    technical.append(event)
                }
                continue
            }
            if isTechnical(event) {
                technical.append(event)
                continue
            }
            if isSignal(event) {
                flushChapter()
                blocks.append(.signal(event))
                continue
            }
            // One action often arrives several times — pre-hook, post-hook,
            // and the provider's own echo of the same call. Keep the last of a
            // same-shaped run: it carries the settled phase and exit state.
            if let last = chapter.last, sameShape(last, event) {
                chapter[chapter.count - 1] = event
            } else {
                chapter.append(event)
            }
        }
        flushPulse()
        flushChapter()
        if let index = receiptIndex, case .receipt(let event, _) = blocks[index], thinkingTokens > 0 {
            blocks[index] = .receipt(event, thinkingTokens: thinkingTokens)
        }
        return Composition(blocks: blocks, technical: technical)
    }

    /// Claude streams a cumulative thinking-token counter; each tick is one
    /// event. Providers whose reasoning events carry prose keep their rows.
    private static func isThinkingPulse(_ event: TaskEventSnapshot) -> Bool {
        event.kind == "reasoning" && event.title == "Thinking"
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
            guard let action = event.actionId, !action.isEmpty, !isTechnical(event) else {
                folded.append(event)
                continue
            }
            if let index = slot[action] {
                folded[index] = settle(folded[index], with: event)
            } else {
                slot[action] = folded.count
                folded.append(event)
            }
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
        var merged = later
        merged.id = first.id
        merged.createdAt = first.createdAt
        if merged.detail == nil { merged.detail = first.detail }
        if merged.presentation == nil { merged.presentation = first.presentation }
        if merged.rawText == nil { merged.rawText = first.rawText }
        if first.phase == "failed" { merged.phase = "failed" }
        return merged
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

    private static func isTechnical(_ event: TaskEventSnapshot) -> Bool {
        if event.minor == true { return !isStalledHeartbeat(event) }
        if event.kind == "raw" { return plumbing.contains(event.title) }
        if event.title == "Heartbeat" { return !isStalledHeartbeat(event) }
        return ["Task queued", "Worker started", "Task completed"].contains(event.title)
    }

    private static func seconds(from start: String, to end: String) -> Int? {
        guard let from = EventClock.date(start), let to = EventClock.date(end) else { return nil }
        let value = Int(to.timeIntervalSince(from).rounded())
        return value > 0 ? value : nil
    }
}

enum ActivityBlock: Identifiable {
    case chapter(id: Int, events: [TaskEventSnapshot])
    case reasoning(ActivityStory.ReasoningPulse)
    case signal(TaskEventSnapshot)
    case receipt(TaskEventSnapshot, thinkingTokens: Int)

    var id: Int {
        switch self {
        case .chapter(let id, _): id
        case .reasoning(let pulse): pulse.id
        case .signal(let event): event.id
        case .receipt(let event, _): event.id
        }
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
