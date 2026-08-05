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
        } else {
            self = .payload
        }
    }

    /// Agent prose, which the row shows clamped and the expansion shows whole.
    /// Same rule the row uses to decide it is a quotation.
    static func isProse(_ event: TaskEventSnapshot) -> Bool {
        event.kind == "message" || (event.kind == "reasoning" && event.title != "Thinking")
    }

    /// Names what the row opens into without parsing the payload — a substring
    /// scan runs on every row, where a parse would run on every frame.
    static func label(for event: TaskEventSnapshot, expanded: Bool) -> String {
        "\(expanded ? "Hide" : "Show") \(noun(for: event))"
    }

    private static func noun(for event: TaskEventSnapshot) -> String {
        let raw = event.rawText ?? ""
        if isProse(event) { return "full text" }
        if event.kind == "file", FileChange.mayContainEdit(raw) { return "changes" }
        if event.kind == "command" { return CommandOutput.mayContainOutput(raw) ? "output" : "full command" }
        return "raw details"
    }
}

/// The expansion under a row, with the payload it came from one click further in
/// — the runs where the argument shapes are what's in question still need it.
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
            case .prose(let text):
                ReviewContentView(source: text)
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
