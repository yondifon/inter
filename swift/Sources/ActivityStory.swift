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
        var chapter: [ChapterRow] = []
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
            blocks.append(.chapter(id: chapter[0].id, rows: chapter))
            chapter = []
        }
        func flushPulse() {
            guard let first = pulse.first, let last = pulse.last else { return }
            thinkingTokens += pulse.reduce(0) { $0 + ($1.presentation?.tokensThinking ?? 0) }
            let line = ReasoningPulse(
                id: first.id,
                detail: (last.detail ?? "Thinking").replacingOccurrences(of: " so far", with: ""),
                updates: pulse.count,
                seconds: seconds(from: first.createdAt, to: last.createdAt)
            )
            // Thinking between two calls belongs to the run they are part of.
            // Ending the chapter for it cut a stretch of work into a card per
            // call, which is how a trace of 80 rows came to be 38 cards.
            if chapter.isEmpty { blocks.append(.reasoning(line)) } else { chapter.append(.reasoning(line)) }
            pulse = []
        }

        for event in events {
            if isThinkingPulse(event) {
                pulse.append(event)
                continue
            }
            // An event nobody sees must not break a run somebody does: a
            // heartbeat between two thinking ticks would otherwise split one
            // pulse line in two.
            if isTechnical(event), event.id != receiptID {
                technical.append(event)
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
                    // A provider that states the run's reasoning total on the
                    // receipt itself needs no summing.
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
            // One action often arrives several times — pre-hook, post-hook,
            // and the provider's own echo of the same call. Keep the last of a
            // same-shaped run: it carries the settled phase and exit state.
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
        "Session Captured", "Archived",
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

enum ActivityBlock: Identifiable {
    case chapter(id: Int, rows: [ChapterRow])
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

/// What a chapter is made of: the work, and the thinking that happened between
/// it. A pulse is a line inside the run, not a break in it.
enum ChapterRow: Identifiable {
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
