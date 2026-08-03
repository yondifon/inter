import Foundation
import SwiftUI

/// What a command printed, recovered from the raw provider payload. Claude sends
/// `tool_response.stdout`, OpenCode `part.state.output`, Codex an aggregated
/// stream — every one of them buried in a payload tree the reader had to walk.
/// Pure, so the reading rules are testable without a view.
struct CommandOutput: Equatable {
    struct Stream: Equatable {
        let isError: Bool
        let lines: [String]
        /// Lines dropped from the head; a long run's tail is what gets read.
        var elided = 0
    }

    let streams: [Stream]
}

extension CommandOutput {
    /// Keys that only ever hold a stream, and keys that hold one when the payload
    /// is about a command at all.
    private static let streamKeys = ["stdout", "stderr"]
    private static let outputKeys = ["output", "aggregated_output", "aggregatedOutput"]
    /// Beyond this the row becomes a wall; the end of a run is what states the
    /// outcome, so the head goes first.
    private static let lineLimit = 200

    static func mayContainOutput(_ raw: String) -> Bool {
        (streamKeys + outputKeys).contains { raw.contains($0) }
    }

    init?(rawEvent source: String) {
        guard let data = source.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        var streams: [Stream] = []
        // `output` on its own is any tool's return value — a read's file, a
        // search's matches. Only a payload that names a command has output that
        // was printed by one.
        CommandOutput.collect(value, naming: source.contains("\"command\""), into: &streams)
        guard !streams.isEmpty else { return nil }
        self.init(streams: streams)
    }

    private static func collect(_ value: JSONValue, naming: Bool, into streams: inout [Stream]) {
        switch value {
        case .object(let fields):
            add(fields["stdout"], isError: false, into: &streams)
            add(fields["stderr"], isError: true, into: &streams)
            if naming {
                for key in outputKeys { add(fields[key], isError: false, into: &streams) }
            }
            for key in fields.keys.sorted() { collect(fields[key]!, naming: naming, into: &streams) }
        case .array(let items):
            for item in items { collect(item, naming: naming, into: &streams) }
        default:
            break
        }
    }

    /// A provider that reports the same stream twice — OpenCode states it on the
    /// tool state and again in its metadata — contributes one block, not two.
    private static func add(_ value: JSONValue?, isError: Bool, into streams: inout [Stream]) {
        guard case .string(let text)? = value else { return }
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        while lines.last?.isEmpty == true { lines.removeLast() }
        guard !lines.isEmpty else { return }
        let elided = max(0, lines.count - lineLimit)
        let stream = Stream(isError: isError, lines: Array(lines.suffix(lineLimit)), elided: elided)
        guard !streams.contains(stream) else { return }
        streams.append(stream)
    }
}

// MARK: - View

/// A command's streams as they were printed. No color: git warns on stderr in
/// runs that went fine, so the stream is named instead of tinted, and failure
/// stays the row's own red.
struct CommandOutputView: View {
    let output: CommandOutput

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(output.streams.enumerated()), id: \.offset) { _, stream in
                VStack(alignment: .leading, spacing: 4) {
                    if stream.isError || output.streams.count > 1 {
                        SectionLabel(text: stream.isError ? "stderr" : "stdout")
                    }
                    if stream.elided > 0 {
                        Text("\(stream.elided) earlier lines")
                            .scaledFont(.caption2, design: .monospaced)
                            .foregroundStyle(.tertiary)
                    }
                    Text(stream.lines.joined(separator: "\n"))
                        .scaledFont(.caption, design: .monospaced)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.sunken, in: RoundedRectangle(cornerRadius: Radius.small))
            }
        }
    }
}
