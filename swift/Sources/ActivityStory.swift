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

    static func compose(_ events: [TaskEventSnapshot]) -> Composition {
        var blocks: [ActivityBlock] = []
        var technical: [TaskEventSnapshot] = []
        var chapter: [TaskEventSnapshot] = []
        var pulse: [TaskEventSnapshot] = []
        let receiptID = events.last { $0.kind == "usage" }?.id

        func flushChapter() {
            guard !chapter.isEmpty else { return }
            blocks.append(.chapter(id: chapter[0].id, events: chapter))
            chapter = []
        }
        func flushPulse() {
            guard let first = pulse.first, let last = pulse.last else { return }
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
            if event.kind == "usage" {
                // Only the final usage event settles the run; earlier per-turn
                // receipts repeat the same shape with smaller numbers.
                if event.id == receiptID {
                    flushChapter()
                    blocks.append(.receipt(event))
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
            chapter.append(event)
        }
        flushPulse()
        flushChapter()
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

    /// Plumbing worth keeping reachable but not worth a row: known protocol
    /// echoes, steady heartbeats, and lifecycle states the header already
    /// shows. An unrecognized raw event stays visible — hiding a new
    /// provider's events would bury the only trace of them.
    private static let plumbing: Set<String> = [
        "Step Start", "Step Finish", "Tool result",
        "Hook Started", "Hook Response", "Status", "Commands Changed",
    ]

    private static func isTechnical(_ event: TaskEventSnapshot) -> Bool {
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
    case receipt(TaskEventSnapshot)

    var id: Int {
        switch self {
        case .chapter(let id, _): id
        case .reasoning(let pulse): pulse.id
        case .signal(let event): event.id
        case .receipt(let event): event.id
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
