import Foundation
import SwiftUI

/// Every file a run changed, gathered from the events the activity list
/// already renders inline. Pure, so the grouping rules are testable without a
/// view, and built on `EventExpansion` — a row that opens on a diff in the
/// activity list is exactly a row that lands here.
struct RunChangeSet: Equatable, Sendable {
    /// One entry per file, in the order the run first changed it.
    let files: [RunFileChanges]
    /// Changes whose payload never named a file, so they belong to no entry.
    let unmatched: Int

    static let empty = RunChangeSet(files: [], unmatched: 0)

    var added: Int { files.reduce(0) { $0 + $1.added } }
    var removed: Int { files.reduce(0) { $0 + $1.removed } }
    var isEmpty: Bool { files.isEmpty && unmatched == 0 }
}

/// One file and everything the run did to it, stacked oldest first.
struct RunFileChanges: Identifiable, Equatable, Sendable {
    let path: String
    /// The stacked hunks, drawn by the same view the activity rows use.
    /// Capped at `RunChanges.lineLimit`; `hiddenLines` counts the rest.
    let change: FileChange
    /// Calls in the run that changed this file.
    let edits: Int
    /// Totals over every hunk, including the ones the cap left out.
    let added: Int
    let removed: Int
    let hiddenLines: Int
    /// A payload the broker shortened before storing it, so at least one line
    /// here stops short of what the worker actually wrote.
    let shortened: Bool

    var id: String { path }
}

enum RunChanges {
    /// Longest stack drawn for one file. Past it the tail is counted rather
    /// than drawn: a file edited forty times would otherwise put thousands of
    /// rows behind a single heading.
    static let lineLimit = 600

    /// The marker the broker leaves on a value it shortened before storing it
    /// — see `boundEventPayload`.
    private static let shortenedMarker = "…[truncated: kept "

    /// `cwd` is the directory the run worked in; files are named from it, so
    /// the same file reached by an absolute and a relative path is one entry.
    static func collect(_ events: [TaskEventSnapshot], cwd: String) -> RunChangeSet {
        var order: [String] = []
        var blocks: [String: [[DiffLine]]] = [:]
        var edits: [String: Int] = [:]
        var unmatched = 0

        for event in ActivityStory.foldActions(events) {
            guard mayHoldChange(event), case .changes(let raw) = EventExpansion(event: event) else { continue }
            guard let path = raw.path.map({ DisplayPath.relative($0, to: cwd) }) else {
                unmatched += 1
                continue
            }
            var stack = blocks[path] ?? []
            // A provider that closes a call under a second action id reaches
            // here twice with the same hunks. The second arrival is the same
            // edit seen again, not another one.
            let fresh = raw.blocks.filter { !stack.contains($0) }
            guard !fresh.isEmpty else { continue }
            if blocks[path] == nil { order.append(path) }
            stack.append(contentsOf: fresh)
            blocks[path] = stack
            edits[path, default: 0] += 1
        }

        return RunChangeSet(
            files: order.map { entry(path: $0, blocks: blocks[$0] ?? [], edits: edits[$0] ?? 0) },
            unmatched: unmatched
        )
    }

    private static func entry(path: String, blocks: [[DiffLine]], edits: Int) -> RunFileChanges {
        var kept: [[DiffLine]] = []
        var drawn = 0
        var hidden = 0
        for block in blocks {
            // The block that crosses the cap is kept whole — half a hunk reads
            // as a diff that lost lines rather than one that was shortened.
            guard drawn < lineLimit else {
                hidden += block.count
                continue
            }
            kept.append(block)
            drawn += block.count
        }
        return RunFileChanges(
            path: path,
            change: FileChange(path: path, blocks: kept),
            edits: edits,
            added: count(blocks, .added),
            removed: count(blocks, .removed),
            hiddenLines: hidden,
            shortened: blocks.contains { block in block.contains { $0.text.contains(shortenedMarker) } }
        )
    }

    private static func count(_ blocks: [[DiffLine]], _ kind: DiffLine.Kind) -> Int {
        blocks.reduce(0) { total, block in total + block.filter { $0.kind == kind }.count }
    }

    /// Cheap gate before parsing: a row that names a file, or a payload
    /// carrying before/after text. Whole-file writes carry neither of the
    /// before/after keys, so the kind is what keeps a created file in.
    private static func mayHoldChange(_ event: TaskEventSnapshot) -> Bool {
        guard let raw = event.rawText else { return false }
        return event.kind == "file" || FileChange.mayContainEdit(raw)
    }
}

// MARK: - View

/// The run read as a set of files instead of a trail through the activity
/// list. It draws no diff of its own — every hunk here is `FileChangeView`,
/// the same view an activity row opens on.
struct RunChangesPanel: View {
    /// Wide enough for a diff line to read without wrapping mid-token, and
    /// narrow enough to leave the trace beside it usable.
    static let width: CGFloat = 380

    let changes: RunChangeSet
    /// The trace is still loading, so an empty list is not yet an answer.
    let loading: Bool
    /// The run can still produce more changes.
    let live: Bool
    /// Activity from earlier in the run that the pane has not fetched.
    let hasEarlier: Bool
    let loadingEarlier: Bool
    let onLoadEarlier: () -> Void
    let onClose: () -> Void

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.5)
            content
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Surface.sidebar)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Changed files").scaledFont(.callout, weight: .semibold)
                if !changes.files.isEmpty {
                    summary
                        .scaledFont(.caption2, design: .monospaced, monospacedDigit: true)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            IconButton(symbol: "xmark", label: "Hide changed files", action: onClose)
                .font(.system(size: 11 * uiScale))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    /// How much the run changed, in the same tally the hunks below are marked
    /// with.
    private var summary: Text {
        let count = changes.files.count
        var result = Text("\(count) file\(count == 1 ? "" : "s")")
        if changes.added > 0 {
            result = result + Text(" · ") + Text("+\(changes.added)").foregroundColor(DiffTint.added)
        }
        if changes.removed > 0 {
            result = result + Text(" · ") + Text("−\(changes.removed)").foregroundColor(DiffTint.removed)
        }
        return result
    }

    @ViewBuilder private var content: some View {
        if loading {
            message {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading…").scaledFont(.caption).foregroundStyle(.secondary)
                }
            }
        } else if changes.files.isEmpty {
            message {
                VStack(alignment: .leading, spacing: 8) {
                    Text(live ? "No files changed yet." : "This run didn’t change any files.")
                        .scaledFont(.caption)
                        .foregroundStyle(.secondary)
                    if live {
                        Text("Changes show up here as the worker edits.")
                            .scaledFont(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    notes
                }
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(changes.files) { file in
                        RunFileRow(file: file)
                    }
                    notes.padding(.top, 2)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollIndicators(.automatic)
        }
    }

    /// What the list cannot speak for: activity the pane has not fetched, and
    /// changes that never named a file. Both would otherwise read as a
    /// complete answer that is quietly short.
    @ViewBuilder private var notes: some View {
        VStack(alignment: .leading, spacing: 6) {
            if changes.unmatched > 0 {
                Text(changes.unmatched == 1
                     ? "1 change didn’t say which file it was in."
                     : "\(changes.unmatched) changes didn’t say which file they were in.")
                    .scaledFont(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if hasEarlier {
                Text("Earlier activity isn’t loaded, so this may not be the whole run.")
                    .scaledFont(.caption2)
                    .foregroundStyle(.tertiary)
                Button(action: onLoadEarlier) {
                    if loadingEarlier {
                        HStack(spacing: 4) { ProgressView().controlSize(.small); Text("Loading…") }
                    } else {
                        Text("Load earlier activity")
                    }
                }
                .buttonStyle(.plain)
                .scaledFont(.caption2)
                .foregroundStyle(.secondary)
                .disabled(loadingEarlier)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func message<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
    }
}

/// One file's heading and its stack of hunks. Open by default: the panel is
/// opened to read a run end to end, and a column of closed rows would make
/// that nine more clicks.
private struct RunFileRow: View {
    let file: RunFileChanges
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CollapsibleSection(
                isExpanded: $expanded,
                label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(file.path)
                            .scaledFont(.caption, design: .monospaced)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(file.path)
                        if file.edits > 1 {
                            Text("\(file.edits) changes")
                                .scaledFont(.caption2, monospacedDigit: true)
                                .foregroundStyle(.tertiary)
                        }
                    }
                },
                trailing: {
                    tally
                        .scaledFont(.caption2, design: .monospaced, monospacedDigit: true)
                        .layoutPriority(1)
                }
            )
            .accessibilityLabel(accessibilityLabel)
            if expanded {
                FileChangeView(change: file.change)
                if file.hiddenLines > 0 {
                    Text(file.hiddenLines == 1 ? "1 more line not shown" : "\(file.hiddenLines) more lines not shown")
                        .scaledFont(.caption2, design: .monospaced)
                        .foregroundStyle(.tertiary)
                }
                if file.shortened {
                    Text("Some lines are missing — the change was too big to keep whole.")
                        .scaledFont(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    /// The same `+`/`−` the lines below are marked with, counted. A file the
    /// run rewrote to the same text has neither, and says so in words.
    private var tally: Text {
        guard file.added > 0 || file.removed > 0 else {
            return Text("no lines changed").foregroundColor(.secondary)
        }
        var result = Text("")
        if file.added > 0 {
            result = result + Text("+\(file.added)").foregroundColor(DiffTint.added)
        }
        if file.added > 0, file.removed > 0 {
            result = result + Text(" ").foregroundColor(.secondary)
        }
        if file.removed > 0 {
            result = result + Text("−\(file.removed)").foregroundColor(DiffTint.removed)
        }
        return result
    }

    private var accessibilityLabel: String {
        var parts = [file.path]
        if file.edits > 1 { parts.append("\(file.edits) changes") }
        parts.append(file.added == 1 ? "1 line added" : "\(file.added) lines added")
        parts.append(file.removed == 1 ? "1 line removed" : "\(file.removed) lines removed")
        return parts.joined(separator: ", ")
    }
}
