import Foundation
import SwiftUI

/// What a row opens into. Every event arrives wrapped in a provider payload, but
/// the reader opened the row for the substance inside it — the lines a call
/// changed, what a command printed, what the agent actually said. The payload is
/// the answer only when it carried nothing better.
enum EventExpansion: Equatable {
    case changes(FileChange)
    /// A command and what it printed. Either half may be missing: a result row
    /// knows the streams but not the call, and a call that printed nothing still
    /// has a command worth reading past the width of a row.
    case command(String?, CommandOutput?)
    case prose(String)
    /// The full text behind a clipped one-line row that is not a quotation — the
    /// message a failure carries, or a lifecycle line too long for its row.
    case detail(String)
    /// Text recovered from the raw payload for a row that neither a diff nor a
    /// command explains: the contents of a file read, or the result of a tool
    /// call.
    case content(ToolContent)
    /// A worker's plan, read as a checklist instead of the JSON it travelled in.
    case todo(TodoPlan)
    case payload

    init(event: TaskEventSnapshot) {
        let raw = event.rawText
        let command = event.presentation?.type == "command" ? event.presentation?.command : nil
        if EventExpansion.isProse(event), let text = event.presentation?.text ?? event.detail {
            self = .prose(text)
        } else if let raw, let change = FileChange(rawEvent: raw) {
            self = .changes(change)
        } else if case let output = raw.flatMap(CommandOutput.init(rawEvent:)),
                  command != nil || output != nil {
            self = .command(command, output)
        } else if EventExpansion.isPlan(event), let raw, let plan = TodoPlan(rawEvent: raw) {
            self = .todo(plan)
        } else if (event.kind == "error" || event.kind == "lifecycle"),
                  let text = event.detail,
                  EventExpansion.isResumeEntry(event) || EventExpansion.isLong(text) {
            self = .detail(text)
        } else if event.kind == "file", let raw, let found = ToolContent.read(rawEvent: raw) {
            self = .content(found)
        } else if event.kind == "tool", let raw, let found = ToolContent.result(rawEvent: raw) {
            self = .content(found)
        } else {
            self = .payload
        }
    }

    /// Agent prose, which the row shows clamped and the expansion shows whole.
    /// Same rule the row uses to decide it is a quotation.
    static func isProse(_ event: TaskEventSnapshot) -> Bool {
        event.kind == "message" || (event.kind == "reasoning" && event.title != "Thinking")
    }

    /// A plan row: the broker's own classification of a todo tool call, and the
    /// gate `init` uses before handing the payload to `TodoPlan`.
    static func isPlan(_ event: TaskEventSnapshot) -> Bool {
        event.presentation?.type == "todo"
    }

    /// A task resumed on its existing provider session. The row carries the
    /// caller's reason when one was given; a retry-style resume with no reason
    /// stays a plain row.
    static func isResumeEntry(_ event: TaskEventSnapshot) -> Bool {
        event.kind == "lifecycle" && event.title == "Resumed"
    }

    /// A clipped line earns its expansion only once it runs past what one line
    /// can hold — the same bar a quotation is held to.
    private static func isLong(_ text: String) -> Bool {
        text.split(whereSeparator: \.isNewline).count > quotePreviewLines
    }

    /// Names what the row opens into without parsing the payload — a substring
    /// scan runs on every row, where a parse would run on every frame.
    static func label(for event: TaskEventSnapshot, expanded: Bool) -> String {
        "\(expanded ? "Hide" : "Show") \(noun(for: event))"
    }

    private static func noun(for event: TaskEventSnapshot) -> String {
        let raw = event.rawText ?? ""
        if isProse(event) { return "full text" }
        if isPlan(event) { return "plan" }
        if isResumeEntry(event) { return "why it was resumed" }
        if event.kind == "error" { return "full error" }
        if event.kind == "lifecycle" { return "full details" }
        if event.kind == "file" {
            if FileChange.mayContainEdit(raw) { return "changes" }
            return ToolContent.mayContainReadable(raw) ? "preview" : "raw details"
        }
        if event.kind == "command" { return CommandOutput.mayContainOutput(raw) ? "output" : "full command" }
        if event.kind == "tool" {
            // A tool result whose payload names a command is a command output —
            // the read and search payloads that carry an `output` key never do.
            if raw.contains("\"command\""), CommandOutput.mayContainOutput(raw) { return "output" }
            return ToolContent.mayContainReadable(raw) ? "result" : "raw details"
        }
        return "raw details"
    }

    /// Lines a collapsed quotation shows before the chevron — the same cap the
    /// quote preview on the row applies. One, because a trace is scanned before
    /// it is read: six lines of an agent quoting a file back to itself buried
    /// the rows around it, and the reader who wants the rest opens the row.
    static let quotePreviewLines = 1

    /// Kinds this file already has a rule for, whether or not that rule found
    /// anything on a given event. Reaching `.payload` with one of these means
    /// the substance of the row really is what the collapsed line already
    /// shows — offering the raw envelope on top of it would be noise, not a
    /// second reading. Only a kind with no rule yet (`raw`, or a shape a
    /// future provider introduces) still earns a look at the payload itself.
    private static let designed: Set<String> = [
        "file", "command", "tool", "error", "lifecycle", "message", "reasoning",
    ]

    /// Whether the chevron earns its place: the expansion holds something the
    /// collapsed row cannot show. The raw-payload button inside the expansion
    /// is not counted — it is a secondary detail, not the substance of the row.
    /// Unlike `label`, this derives from the parsed expansion rather than
    /// substring guesses, so the two never disagree about what a row opens on.
    static func shouldOfferExpansion(_ event: TaskEventSnapshot) -> Bool {
        switch EventExpansion(event: event) {
        case .changes:
            return true
        case .command(let command, let output):
            // The call already sits on the title line; only output or a
            // script spanning lines is more than that line can show.
            return output != nil || command?.contains(where: \.isNewline) == true
        case .prose(let text), .detail(let text):
            return EventExpansion.isResumeEntry(event) || EventExpansion.isLong(text)
        case .content:
            return true
        case .todo:
            return true
        case .payload:
            guard !(event.rawText ?? "").isEmpty else { return false }
            return !EventExpansion.designed.contains(event.kind)
        }
    }
}

/// Free text recovered from the raw payload when neither a diff nor a command
/// stream explains the row: the contents of a file read, or the result of a
/// tool call — search matches, a directory listing, the text response of an
/// MCP call. Every provider nests these differently, so the search walks the
/// payload the same way `FileChange` and `CommandOutput` already do for their
/// own shapes. Pure, so the recovery rules are testable without a view.
struct ToolContent: Equatable {
    let text: String
    let hiddenLines: Int

    /// Beyond this a preview is a wall; the head is what a reader scans first.
    private static let lineLimit = 200

    private init(full: String) {
        var lines = full.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        while lines.last?.isEmpty == true { lines.removeLast() }
        hiddenLines = max(0, lines.count - ToolContent.lineLimit)
        text = lines.prefix(ToolContent.lineLimit).joined(separator: "\n")
    }
}

extension ToolContent {
    /// Keys under which the text of a file read travels.
    private static let readKeys = ["content", "text", "file_text", "fileText", "output"]
    /// Keys under which a tool result travels, from a plain string to the
    /// `[{type: "text", text: "…"}]` shape most tool results eventually
    /// reduce to.
    private static let resultKeys = ["tool_response", "result", "output", "matches", "content"]

    static func read(rawEvent source: String) -> ToolContent? {
        ToolContent(rawEvent: source, keys: readKeys)
    }

    static func result(rawEvent source: String) -> ToolContent? {
        ToolContent(rawEvent: source, keys: resultKeys)
    }

    /// Cheap enough to run on every row, matching `FileChange.mayContainEdit`
    /// and `CommandOutput.mayContainOutput`: a substring scan the label can
    /// afford, where a parse could not.
    static func mayContainReadable(_ raw: String) -> Bool {
        (readKeys + resultKeys).contains { raw.contains($0) }
    }

    private init?(rawEvent source: String, keys: [String]) {
        guard let data = source.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let found = ToolContent.search(value, keys: keys) else { return nil }
        self.init(full: found)
    }

    private static func search(_ value: JSONValue, keys: [String]) -> String? {
        switch value {
        case .object(let fields):
            for key in keys {
                if let candidate = fields[key], let found = textValue(candidate) { return found }
            }
            for key in fields.keys.sorted() {
                if let found = search(fields[key]!, keys: keys) { return found }
            }
            return nil
        case .array(let items):
            for item in items {
                if let found = search(item, keys: keys) { return found }
            }
            return nil
        default:
            return nil
        }
    }

    /// A plain string, the `[{type: "text", text: "…"}]` shape most tool
    /// results eventually reduce to, or a bare list of strings — the file
    /// names a search returns with nothing else worth naming them.
    private static func textValue(_ value: JSONValue) -> String? {
        switch value {
        case .string(let found):
            return found.isEmpty ? nil : found
        case .array(let items):
            let blocks = items.compactMap { item -> String? in
                if case .object(let fields) = item, case .string(let found)? = fields["text"] { return found }
                if case .string(let found) = item { return found }
                return nil
            }
            return blocks.isEmpty ? nil : blocks.joined(separator: "\n")
        default:
            return nil
        }
    }
}

extension ToolContent {
    /// The write-time marker the broker leaves on a value it already
    /// shortened before this app ever saw it — see `boundEventPayload`.
    /// `display` and `truncationNote` split that marker into a caption of its
    /// own instead of leaving it as trailing text a reader could mistake for
    /// content.
    private static let truncationPattern = try! NSRegularExpression(
        pattern: #"\s*…\[truncated: kept (\d+) of (\d+) bytes\]$"#
    )

    private var truncationMatch: NSTextCheckingResult? {
        let range = NSRange(text.startIndex..., in: text)
        return ToolContent.truncationPattern.firstMatch(in: text, range: range)
    }

    /// `text` with the inline marker from the broker removed.
    var display: String {
        guard let match = truncationMatch, let range = Range(match.range, in: text) else { return text }
        return String(text[..<range.lowerBound])
    }

    /// A value the broker already shortened before this app ever saw it reads
    /// as shortened, not as complete — the byte counts its marker carried, in
    /// the units the rest of the trace uses.
    var truncationNote: String? {
        guard let match = truncationMatch,
              let keptRange = Range(match.range(at: 1), in: text),
              let totalRange = Range(match.range(at: 2), in: text),
              let kept = Int(text[keptRange]), let total = Int(text[totalRange]) else { return nil }
        return "Shortened when captured — kept \(ActivityFormat.bytes(kept)) of \(ActivityFormat.bytes(total))"
    }
}

/// The expansion under a row, with the payload it came from one click further
/// in — the runs where the shape of an argument is what is in question still
/// need it.
struct EventExpansionView: View {
    let event: TaskEventSnapshot
    @State private var showingPayload = false

    var body: some View {
        let expansion = EventExpansion(event: event)
        VStack(alignment: .leading, spacing: 6) {
            switch expansion {
            case .changes(let change):
                FileChangeView(change: change)
            case .command(let command, let output):
                if let command {
                    Text(CodeStyle.highlighted(command, language: .hashFamily))
                        .scaledFont(.caption, design: .monospaced)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
                }
                if let output { CommandOutputView(output: output) }
            case .prose(let text), .detail(let text):
                ReviewContentView(source: text)
            case .content(let found):
                ToolContentView(
                    content: found,
                    language: event.kind == "file" ? CodeLanguage(path: event.presentation?.path) : .none
                )
            case .todo(let plan):
                TodoPlanView(plan: plan)
            case .payload:
                EmptyView()
            }
            if let raw = event.rawText {
                if expansion != .payload {
                    Button(showingPayload ? "Hide raw event" : "Show raw event") {
                        withAnimation(.easeOut(duration: 0.15)) { showingPayload.toggle() }
                    }
                    .buttonStyle(.plain)
                    .scaledFont(.caption2)
                    .foregroundStyle(.tertiary)
                }
                if showingPayload || expansion == .payload {
                    ReviewContentView(source: raw, initiallyExpandJSON: false).transition(.opacity)
                }
            }
        }
    }
}

/// The recovered text of a tool call, not classified but still worth reading:
/// capped the way the output of a command is, with a value the broker already
/// shortened read as shortened rather than silently cut again.
private struct ToolContentView: View {
    let content: ToolContent
    var language: CodeLanguage = .none

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(CodeStyle.highlighted(content.display, language: language))
                .scaledFont(.caption, design: .monospaced)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if content.hiddenLines > 0 {
                Text(content.hiddenLines == 1 ? "1 more line" : "\(content.hiddenLines) more lines")
                    .scaledFont(.caption2, design: .monospaced)
                    .foregroundStyle(.tertiary)
            }
            if let note = content.truncationNote {
                Text(note)
                    .scaledFont(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
    }
}

/// One checklist line: the item text and its state, with the source order the
/// worker's plan is read in.
struct TodoItem: Equatable {
    enum Status: String, Equatable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    let text: String
    let status: Status
}

/// A worker's plan as typed items, recovered from the raw payload the way
/// `FileChange` and `CommandOutput` recover theirs — the broker's presentation
/// carries only the tallies, the list itself lives in the payload.
struct TodoPlan: Equatable {
    let items: [TodoItem]

    var completedCount: Int { items.filter { $0.status == .completed }.count }
    var total: Int { items.count }
    /// The item the worker is on now, when the plan names one.
    var activeText: String? { items.first { $0.status == .inProgress }?.text }
}

extension TodoPlan {
    /// Text keys the same item travels under across providers.
    private static let textKeys = ["content", "text", "description", "activeForm"]

    init?(rawEvent source: String) {
        guard let data = source.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let items = TodoPlan.collect(value) else { return nil }
        self.items = items
    }

    /// The plan is an array of objects that each carry an item text — the shape
    /// every provider's todo tool settles on — with `status` or `completed`
    /// marking the state when present. A list that does not fully read as one
    /// is treated as absent, so a malformed payload keeps its raw fallback.
    private static func collect(_ value: JSONValue) -> [TodoItem]? {
        switch value {
        case .object(let fields):
            for key in fields.keys.sorted() {
                if let found = collect(fields[key]!) { return found }
            }
            return nil
        case .array(let items):
            let parsed = items.compactMap(TodoPlan.item)
            if !parsed.isEmpty, parsed.count == items.count { return parsed }
            for item in items {
                if let found = collect(item) { return found }
            }
            return nil
        default:
            return nil
        }
    }

    private static func item(_ value: JSONValue) -> TodoItem? {
        guard case .object(let fields) = value else { return nil }
        guard let text = textKeys.compactMap({ key -> String? in
            guard case .string(let value)? = fields[key] else { return nil }
            return TodoPlan.clean(value)
        }).first else { return nil }
        let status: TodoItem.Status
        if case .string(let raw)? = fields["status"] {
            status = TodoItem.Status(rawValue: raw) ?? .pending
        } else if case .boolean(let done)? = fields["completed"] {
            status = done ? .completed : .pending
        } else {
            status = .pending
        }
        return TodoItem(text: text, status: status)
    }

    /// The write-time marker the broker leaves on a value it already shortened
    /// before this app ever saw it — see `boundEventPayload`. The marker is
    /// broker bookkeeping, not item text.
    private static let truncationPattern = try! NSRegularExpression(
        pattern: #"\s*…\[truncated: kept (\d+) of (\d+) bytes\]$"#
    )

    private static func clean(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let range = NSRange(value.startIndex..., in: value)
        guard let match = truncationPattern.firstMatch(in: value, range: range),
              let cut = Range(match.range, in: value) else { return value }
        return String(value[..<cut.lowerBound])
    }
}

/// A plan read as a checklist: done items checked and muted, the item in
/// progress at full strength, the rest plain. Order stays the worker's.
private struct TodoPlanView: View {
    let plan: TodoPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                TodoItemRow(item: item)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
    }
}

private struct TodoItemRow: View {
    let item: TodoItem

    @Environment(\.uiScale) private var uiScale

    private var symbol: String {
        switch item.status {
        case .completed: "checkmark.circle"
        case .inProgress: "circle.inset.filled"
        case .pending: "circle"
        }
    }

    private var indicatorTint: AnyShapeStyle {
        switch item.status {
        case .completed: AnyShapeStyle(.tertiary)
        case .inProgress: AnyShapeStyle(.blue)
        case .pending: AnyShapeStyle(.tertiary)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            EventIcon(symbol: symbol, weight: .medium)
                .foregroundStyle(indicatorTint)
                .padding(.top, 1.5 * uiScale)
            Text(item.text)
                .scaledFont(.caption, weight: item.status == .inProgress ? .semibold : .regular)
                .foregroundStyle(item.status == .inProgress ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}
