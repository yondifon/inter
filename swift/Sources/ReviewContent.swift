import Foundation
import SwiftUI

enum ReviewContent: Equatable {
    case json(JSONValue)
    case markdown([MarkdownBlock])

    init(_ source: String) {
        if let data = source.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            self = .json(value)
        } else {
            self = .markdown(MarkdownParser.parse(source))
        }
    }
}

indirect enum JSONValue: Decodable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    var typeLabel: String {
        switch self {
        case .object: "Object"
        case .array: "Array"
        case .string: "Text"
        case .number: "Number"
        case .boolean: "Boolean"
        case .null: "Null"
        }
    }

    var summary: String {
        switch self {
        case .object(let values): "\(values.count) field\(values.count == 1 ? "" : "s")"
        case .array(let values): "\(values.count) item\(values.count == 1 ? "" : "s")"
        case .string(let value): value
        case .number(let value):
            value.rounded() == value ? String(Int(value)) : String(value)
        case .boolean(let value): value ? "true" : "false"
        case .null: "—"
        }
    }

    var children: [(String, JSONValue)] {
        switch self {
        case .object(let values):
            values.keys.sorted().map { ($0, values[$0]!) }
        case .array(let values):
            values.enumerated().map { (String($0.offset + 1), $0.element) }
        default:
            []
        }
    }
}

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case unorderedList([String])
    case orderedList([String])
    case quote(String)
    case code(language: String?, text: String)
    case table(headers: [String], rows: [[String]])
    case divider
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                index += 1
                continue
            }

            if line.hasPrefix("```") {
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var code: [String] = []
                while index < lines.count, !lines[index].hasPrefix("```") {
                    code.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: code.joined(separator: "\n")))
                continue
            }

            if let heading = heading(from: line) {
                blocks.append(heading)
                index += 1
                continue
            }

            if isDivider(line) {
                blocks.append(.divider)
                index += 1
                continue
            }

            if index + 1 < lines.count, line.contains("|"), isTableDivider(lines[index + 1]) {
                let headers = cells(in: line)
                index += 2
                var rows: [[String]] = []
                while index < lines.count, lines[index].contains("|"),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(cells(in: lines[index]))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if isUnorderedItem(line) {
                var items: [String] = []
                while index < lines.count, isUnorderedItem(lines[index]) {
                    items.append(String(lines[index].dropFirst(2)))
                    index += 1
                }
                blocks.append(.unorderedList(items))
                continue
            }

            if let item = orderedItem(line) {
                var items = [item]
                index += 1
                while index < lines.count, let next = orderedItem(lines[index]) {
                    items.append(next)
                    index += 1
                }
                blocks.append(.orderedList(items))
                continue
            }

            if line.hasPrefix("> ") {
                var quote: [String] = []
                while index < lines.count, lines[index].hasPrefix("> ") {
                    quote.append(String(lines[index].dropFirst(2)))
                    index += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }

            var paragraph = [line]
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  !startsBlock(lines, at: index) {
                paragraph.append(lines[index])
                index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    private static func heading(from line: String) -> MarkdownBlock? {
        let count = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(count), line.dropFirst(count).hasPrefix(" ") else { return nil }
        return .heading(level: count, text: String(line.dropFirst(count + 1)))
    }

    private static func isDivider(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        return compact.count >= 3 && (Set(compact) == ["-"] || Set(compact) == ["*"])
    }

    private static func isUnorderedItem(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ")
    }

    private static func orderedItem(_ line: String) -> String? {
        guard let dot = line.firstIndex(of: "."),
              line.index(after: dot) < line.endIndex,
              line[line.index(after: dot)] == " ",
              !line[..<dot].isEmpty,
              line[..<dot].allSatisfy(\.isNumber) else { return nil }
        return String(line[line.index(dot, offsetBy: 2)...])
    }

    private static func cells(in line: String) -> [String] {
        line.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableDivider(_ line: String) -> Bool {
        let values = cells(in: line)
        return !values.isEmpty && values.allSatisfy {
            $0.trimmingCharacters(in: CharacterSet(charactersIn: ":-")).isEmpty &&
            $0.filter { $0 == "-" }.count >= 3
        }
    }

    private static func startsBlock(_ lines: [String], at index: Int) -> Bool {
        let line = lines[index]
        return line.hasPrefix("```") || heading(from: line) != nil || isDivider(line) ||
            isUnorderedItem(line) || orderedItem(line) != nil || line.hasPrefix("> ") ||
            (index + 1 < lines.count && line.contains("|") && isTableDivider(lines[index + 1]))
    }
}

struct ReviewContentView: View {
    let source: String

    var body: some View {
        switch ReviewContent(source) {
        case .json(let value):
            JSONTableView(value: value)
        case .markdown(let blocks):
            MarkdownDocumentView(blocks: blocks)
        }
    }
}

private struct MarkdownDocumentView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    @ViewBuilder var body: some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 4 : 0)
        case .paragraph(let text):
            inline(text).font(.body)
        case .unorderedList(let items):
            list(items: items, ordered: false)
        case .orderedList(let items):
            list(items: items, ordered: true)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(.secondary.opacity(0.45)).frame(width: 3)
                inline(text).foregroundStyle(.secondary)
            }
        case .code(let language, let text):
            VStack(alignment: .leading, spacing: 6) {
                if let language {
                    Text(language.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                ScrollView(.horizontal) {
                    Text(text)
                        .font(.callout.monospaced())
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(12)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        case .table(let headers, let rows):
            MarkdownTable(headers: headers, rows: rows)
        case .divider:
            Divider()
        }
    }

    private func inline(_ source: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return Text((try? AttributedString(markdown: source, options: options)) ?? AttributedString(source))
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.bold)
        case 2: .title3.weight(.semibold)
        default: .headline
        }
    }

    private func list(items: [String], ordered: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(ordered ? "\(index + 1)." : "•")
                        .foregroundStyle(.secondary)
                        .frame(width: 20, alignment: .trailing)
                    inline(item)
                }
            }
        }
    }
}

private struct MarkdownTable: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        Text(header).font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary).padding(.vertical, 8)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(headers.indices, id: \.self) { column in
                            Text(column < row.count ? row[column] : "—").padding(.vertical, 7)
                        }
                    }
                    Divider()
                }
            }
            .font(.callout)
        }
    }
}

private struct JSONTableView: View {
    let value: JSONValue

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Field").frame(maxWidth: .infinity, alignment: .leading)
                Text("Value").frame(maxWidth: .infinity, alignment: .leading)
                Text("Type").frame(width: 72, alignment: .leading)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.vertical, 7)
            .background(Color(nsColor: .textBackgroundColor))
            JSONTreeRow(name: "Root", value: value, depth: 0, initiallyExpanded: true)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(nsColor: .separatorColor)))
    }
}

private struct JSONTreeRow: View {
    let name: String
    let value: JSONValue
    let depth: Int
    @State private var expanded: Bool

    init(name: String, value: JSONValue, depth: Int, initiallyExpanded: Bool = false) {
        self.name = name
        self.value = value
        self.depth = depth
        _expanded = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                HStack(spacing: 5) {
                    if !value.children.isEmpty {
                        Button { expanded.toggle() } label: {
                            Image(systemName: expanded ? "chevron.down" : "chevron.right")
                                .font(.caption2.weight(.semibold)).frame(width: 14, height: 20)
                        }
                        .buttonStyle(.plain)
                    } else {
                        Color.clear.frame(width: 14, height: 20)
                    }
                    Text(name).font(.callout.weight(.medium)).lineLimit(1)
                }
                .padding(.leading, CGFloat(depth * 16))
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(value.summary).font(.callout.monospaced())
                    .foregroundStyle(value.children.isEmpty ? .primary : .secondary)
                    .lineLimit(2).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(value.typeLabel).font(.caption).foregroundStyle(.tertiary)
                    .frame(width: 72, alignment: .leading)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)

            if expanded {
                ForEach(Array(value.children.enumerated()), id: \.offset) { _, child in
                    JSONTreeRow(name: child.0, value: child.1, depth: depth + 1)
                }
            }
        }
    }
}
