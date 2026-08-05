import Foundation
import SwiftUI

/// Maps a work row's title to a category glyph, so a long trace reads by
/// shape instead of by re-reading the same handful of tool names over and
/// over. Pure and view-free, like `ActivityStory` — an icon is a claim of
/// certainty, so this only ever answers for a title it recognizes on sight;
/// everything else returns nil and the row keeps its name. A wrong or
/// generic glyph would erase the one thing an unfamiliar row still told the
/// reader, which is strictly worse than the word.
enum ToolIcon {
    /// Keyed by the title lowercased, so lookup is case-insensitive. Some
    /// tools get two entries on purpose: the event normalizer is mid-rewrite
    /// from raw camelCase titles (`ToolSearch`, `TaskCreate`) to sentence-case
    /// prose (`Tool search`, `Create task`) for the same tool, and the two
    /// spellings differ by more than casing, so lowercasing alone can't
    /// unify them — both forms are listed by hand until the rewrite ships
    /// everywhere in the stored history.
    private static let named: [String: String] = [
        "bash": "terminal",
        "run command": "terminal",
        "read file": "doc.text",
        "edit file": "square.and.pencil",
        "write file": "doc.badge.plus",
        // codex reports every file mutation under this one title, with
        // nothing in the title itself to say created vs. edited vs.
        // deleted — it reads closest to a write, the shape for "a file
        // changed" rather than "a file was read".
        "file change": "doc.badge.plus",
        "search code": "text.magnifyingglass",
        "find files": "folder.badge.questionmark",
        "list files": "list.bullet",
        "web search": "globe",
        "fetch page": "arrow.down.doc",
        "todo list": "checklist",
        "subagent": "person.2",
        "skill": "wand.and.stars",
        "apply patch": "bandage",
        "tool search": "magnifyingglass",
        "toolsearch": "magnifyingglass",
        // Inter's own task-tracking tool, called by claude, opencode, and
        // pi to plan and update the run's own work list. Create and update
        // share a glyph on purpose: to a reader scanning the trace both are
        // the same event — "the plan changed" — and splitting them would
        // spend two shapes to say one thing.
        "plan update": "list.clipboard",
        "taskcreate": "list.clipboard",
        "create task": "list.clipboard",
        "taskupdate": "list.clipboard",
        "update task": "list.clipboard",
        "list permissions": "checkmark.shield",
        // codex's REPL call. It is code execution, like Bash, but a reader
        // scanning shells apart from scripts benefits from its own mark
        // rather than borrowing the terminal glyph.
        "node repl: js": "chevron.left.forwardslash.chevron.right",
    ]

    /// The glyph for a work row's title, or nil when the row should keep its
    /// text. `kind` gates the MCP fallback below: every MCP-shaped title
    /// seen in the stored history arrived as a `"tool"` event, while a
    /// `"file"` or `"command"` row already carries its own path or command
    /// line as evidence — guessing a puzzle piece there would trade real
    /// information for a generic one.
    static func symbolName(title: String, kind: String) -> String? {
        let key = title.lowercased()
        if let hit = named[key] { return hit }
        guard kind == "tool", isMCPShaped(title) else { return nil }
        return "puzzlepiece.extension"
    }

    static func symbolName(for event: TaskEventSnapshot) -> String? {
        symbolName(title: event.title, kind: event.kind)
    }

    /// An MCP call's title is `<server> <function>` or `<server>: <function>`
    /// — the server can be anything a user has installed, so there is no
    /// fixed vocabulary to match against, only a shape: two or more Title
    /// Case words, joined by a space or a colon. This app's own titles never
    /// take that shape — they are sentence case, capitalizing only their
    /// first word ("Web search", "Search code") — so the table above is
    /// always checked first and this rule only ever catches what it isn't.
    private static func isMCPShaped(_ title: String) -> Bool {
        if title.contains(": ") { return true }
        let words = title.split(separator: " ")
        guard words.count >= 2 else { return false }
        return words.allSatisfy { $0.first?.isUppercase ?? false }
    }
}

/// One box for every event icon, whatever the glyph. SF Symbols scale with
/// their font and differ in intrinsic proportions, so the same font size
/// still draws a `brain` larger than a `terminal`; a fixed frame with the
/// symbol scaled to fit and centered is what actually pins them to one
/// visual size. The box edge is the size the trace's dominant work-row
/// icons (callout, 12 pt) already read at, plus a little room so tall
/// glyphs like `puzzlepiece.extension` shrink into the box instead of
/// stretching the row. Sits here rather than in DesignSystem.swift beside
/// `IconButton` because that file is under concurrent edit; it can move
/// there once that settles.
struct EventIcon: View {
    /// Box edge, in points at uiScale 1.
    static let box: CGFloat = 14

    let symbol: String
    var weight: Font.Weight = .medium

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        // `.resizable()` exists only on Image, so it must come before any
        // modifier that erases to `some View`; weight survives as fontWeight.
        Image(systemName: symbol)
            .resizable()
            .scaledToFit()
            .fontWeight(weight)
            .frame(width: EventIcon.box * uiScale, height: EventIcon.box * uiScale)
    }
}
