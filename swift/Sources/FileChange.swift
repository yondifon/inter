import Foundation
import SwiftUI

/// What a file call actually changed, recovered from the raw provider payload.
/// Every provider nests tool arguments differently — Claude sends `tool_input`,
/// OpenCode `part.state.input` — so the arguments are found by searching for the
/// shape instead of following a fixed path. Pure, so the diff rules are testable
/// without a view.
struct FileChange: Equatable {
    let path: String?
    /// One block per replacement; a multi-edit call carries several.
    let blocks: [[DiffLine]]

    var added: Int { count(of: .added) }
    var removed: Int { count(of: .removed) }

    private func count(of kind: DiffLine.Kind) -> Int {
        blocks.reduce(0) { total, block in total + block.filter { $0.kind == kind }.count }
    }
}

struct DiffLine: Equatable {
    enum Kind: Equatable { case context, added, removed, skipped }

    let kind: Kind
    let text: String
}

// MARK: - Recovery from a raw payload

extension FileChange {
    /// Keys the same argument travels under across providers.
    private static let pathKeys = ["file_path", "filePath", "path"]
    private static let oldKeys = ["old_string", "oldString", "old_text", "oldText"]
    private static let newKeys = ["new_string", "newString", "new_text", "newText"]
    private static let contentKeys = ["content", "text"]
    private static let inputKeys = ["tool_input", "input", "arguments"]

    /// Cheap enough to run on every row: the substrings only a payload carrying
    /// before/after text can hold. Parsing the payload is left to expansion.
    static func mayContainEdit(_ raw: String) -> Bool {
        (oldKeys + newKeys + ["structuredPatch"]).contains { raw.contains($0) }
    }

    init?(rawEvent source: String) {
        guard let data = source.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let change = FileChange.search(value, path: nil, inInput: false) else { return nil }
        self = change
    }

    private static func search(_ value: JSONValue, path inherited: String?, inInput: Bool) -> FileChange? {
        switch value {
        case .object(let fields):
            let path = string(fields, pathKeys) ?? inherited
            // Either side may be empty — that is an insertion or a deletion, not
            // a missing argument.
            if let old = rawString(fields, oldKeys), let new = rawString(fields, newKeys),
               !old.isEmpty || !new.isEmpty {
                return FileChange(path: path, blocks: [diff(old: old, new: new)])
            }
            // The call's own arguments describe the change best, and taking them
            // first keeps a response that echoes the same edit from showing it
            // twice.
            for key in inputKeys {
                if let nested = fields[key],
                   let found = search(nested, path: path, inInput: true) { return found }
            }
            // `content` on its own is ambiguous — a read's response carries the
            // file it read, which changed nothing. Only a call's arguments are
            // read as new text.
            if inInput, let path, let content = string(fields, contentKeys) {
                return FileChange(path: path, blocks: [collapse(lines(content).map {
                    DiffLine(kind: .added, text: $0)
                })])
            }
            if let patch = fields["structuredPatch"], let found = hunks(patch, path: path) { return found }
            return merge(
                fields.keys.sorted().compactMap { search(fields[$0]!, path: path, inInput: inInput) },
                path: path
            )
        case .array(let items):
            return merge(
                items.compactMap { search($0, path: inherited, inInput: inInput) },
                path: inherited
            )
        default:
            return nil
        }
    }

    /// Claude's edit result carries the patch it applied, with the surrounding
    /// lines the arguments never include. Used when the payload kept the result
    /// but not the call.
    private static func hunks(_ value: JSONValue, path: String?) -> FileChange? {
        guard case .array(let items) = value else { return nil }
        var blocks: [[DiffLine]] = []
        for item in items {
            guard case .object(let hunk) = item, case .array(let lines)? = hunk["lines"] else { continue }
            let parsed: [DiffLine] = lines.compactMap { line in
                guard case .string(let text) = line else { return nil }
                switch text.first {
                case "+": return DiffLine(kind: .added, text: String(text.dropFirst()))
                case "-": return DiffLine(kind: .removed, text: String(text.dropFirst()))
                case " ": return DiffLine(kind: .context, text: String(text.dropFirst()))
                default: return DiffLine(kind: .context, text: text)
                }
            }
            if !parsed.isEmpty { blocks.append(collapse(parsed)) }
        }
        return blocks.isEmpty ? nil : FileChange(path: path, blocks: blocks)
    }

    private static func merge(_ found: [FileChange], path: String?) -> FileChange? {
        var blocks: [[DiffLine]] = []
        for change in found {
            for block in change.blocks where !blocks.contains(block) { blocks.append(block) }
        }
        guard !blocks.isEmpty else { return nil }
        return FileChange(path: found.first { $0.path != nil }?.path ?? path, blocks: blocks)
    }

    private static func string(_ fields: [String: JSONValue], _ keys: [String]) -> String? {
        rawString(fields, keys).flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func rawString(_ fields: [String: JSONValue], _ keys: [String]) -> String? {
        for key in keys {
            if case .string(let value)? = fields[key] { return value }
        }
        return nil
    }
}

// MARK: - Diff

extension FileChange {
    /// Past this many lines on either side the table below costs more than the
    /// reading it buys, and a block that long is read as a block anyway.
    private static let pairLimit = 400
    /// Untouched lines kept on each side of a change.
    private static let margin = 3
    /// Longest block rendered whole; the rest is counted, not printed.
    private static let blockLimit = 200

    static func diff(old: String, new: String) -> [DiffLine] {
        let before = lines(old)
        let after = lines(new)
        guard before.count <= pairLimit, after.count <= pairLimit else {
            return collapse(before.map { DiffLine(kind: .removed, text: $0) }
                + after.map { DiffLine(kind: .added, text: $0) })
        }
        return collapse(group(align(before, after)))
    }

    private static func lines(_ value: String) -> [String] {
        guard !value.isEmpty else { return [] }
        var parts = value.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        // A trailing newline ends the last line; it does not add an empty one.
        if parts.count > 1, parts.last?.isEmpty == true { parts.removeLast() }
        return parts
    }

    /// Longest common subsequence over lines. The strings a tool call carries are
    /// a fragment of a file, not a repository, so the table costs nothing at these
    /// sizes and matches better than any prefix/suffix heuristic.
    private static func align(_ before: [String], _ after: [String]) -> [DiffLine] {
        var table = [[Int]](repeating: [Int](repeating: 0, count: after.count + 1), count: before.count + 1)
        for i in stride(from: before.count - 1, through: 0, by: -1) {
            for j in stride(from: after.count - 1, through: 0, by: -1) {
                table[i][j] = before[i] == after[j]
                    ? table[i + 1][j + 1] + 1
                    : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var result: [DiffLine] = []
        var i = 0
        var j = 0
        while i < before.count, j < after.count {
            if before[i] == after[j] {
                result.append(DiffLine(kind: .context, text: before[i]))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                result.append(DiffLine(kind: .removed, text: before[i]))
                i += 1
            } else {
                result.append(DiffLine(kind: .added, text: after[j]))
                j += 1
            }
        }
        result.append(contentsOf: before[i...].map { DiffLine(kind: .removed, text: $0) })
        result.append(contentsOf: after[j...].map { DiffLine(kind: .added, text: $0) })
        return result
    }

    /// A change reads as one block replaced by another, so a run of changed lines
    /// lists every removal before the additions rather than alternating them.
    private static func group(_ lines: [DiffLine]) -> [DiffLine] {
        var result: [DiffLine] = []
        var run: [DiffLine] = []
        func flush() {
            result.append(contentsOf: run.filter { $0.kind == .removed })
            result.append(contentsOf: run.filter { $0.kind == .added })
            run = []
        }
        for line in lines {
            if line.kind == .context {
                flush()
                result.append(line)
            } else {
                run.append(line)
            }
        }
        flush()
        return result
    }

    /// Untouched stretches between changes carry no information; a few lines on
    /// each side are enough to place the change in its surroundings.
    private static func collapse(_ lines: [DiffLine]) -> [DiffLine] {
        var keep = [Bool](repeating: false, count: lines.count)
        for (index, line) in lines.enumerated() where line.kind != .context {
            for near in max(0, index - margin)...min(lines.count - 1, index + margin) { keep[near] = true }
        }
        guard keep.contains(true) else { return capped(lines) }
        var result: [DiffLine] = []
        var index = 0
        while index < lines.count {
            guard !keep[index] else {
                result.append(lines[index])
                index += 1
                continue
            }
            let start = index
            while index < lines.count, !keep[index] { index += 1 }
            let skipped = index - start
            // One elided line costs as much room as the line itself.
            guard skipped > 1 else {
                result.append(lines[start])
                continue
            }
            result.append(DiffLine(kind: .skipped, text: "\(skipped) unchanged lines"))
        }
        return capped(result)
    }

    private static func capped(_ lines: [DiffLine]) -> [DiffLine] {
        guard lines.count > blockLimit else { return lines }
        let rest = lines.count - blockLimit
        return Array(lines.prefix(blockLimit))
            + [DiffLine(kind: .skipped, text: "\(rest) more line\(rest == 1 ? "" : "s")")]
    }
}

// MARK: - View

/// The before and after of a file call. The row above already names the file and
/// the size of the change, so this shows only the text that moved.
///
/// This is the one place the trace tints lines by meaning rather than severity —
/// a diff is read that way everywhere — and the markers carry it on their own
/// where color does not land.
struct FileChangeView: View {
    let change: FileChange

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(change.blocks.enumerated()), id: \.offset) { _, block in
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(block.enumerated()), id: \.offset) { _, line in
                        DiffLineRow(line: line)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small))
            }
        }
    }
}

private struct DiffLineRow: View {
    let line: DiffLine

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        if line.kind == .skipped {
            Text(line.text)
                .scaledFont(.caption2, design: .monospaced)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(alignment: .top, spacing: 6) {
                Text(marker)
                    .scaledFont(.caption, weight: .semibold, design: .monospaced)
                    .foregroundStyle(tint)
                    .frame(width: 8 * uiScale, alignment: .leading)
                Text(line.text.isEmpty ? " " : line.text)
                    .scaledFont(.caption, design: .monospaced)
                    .foregroundStyle(line.kind == .context ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(role): \(line.text)")
        }
    }

    private var marker: String {
        switch line.kind {
        case .added: "+"
        case .removed: "−"
        default: " "
        }
    }

    private var role: String {
        switch line.kind {
        case .added: "Added"
        case .removed: "Removed"
        default: "Unchanged"
        }
    }

    private var tint: Color {
        switch line.kind {
        case .added: .green
        case .removed: .red
        default: .secondary
        }
    }

    private var fill: Color {
        switch line.kind {
        case .added: .green.opacity(0.12)
        case .removed: .red.opacity(0.12)
        default: .clear
        }
    }
}
