import Foundation
import SwiftUI

/// Maps a work row's title to the verb that opens its line, so a trace reads
/// as a story — "Reading", "Ran", "Edited" — instead of a column of glyphs.
/// Pure and view-free, like `ActivityStory`; a verb is a claim of certainty,
/// so this only ever answers for a title it recognizes on sight. Everything
/// else returns nil and the row keeps its title: a wrong or invented verb
/// would misname what an unfamiliar row did, which is strictly worse than
/// the word.
enum ToolIcon {
    /// One verb in two tenses. The trace narrates a live run in the present
    /// ("Editing") and a settled one in the past ("Edited"): while a task is
    /// still moving its rows read as work in flight, and once it settles they
    /// read as a record.
    private struct Tense {
        let past: String
        let present: String
    }

    /// Keyed by the title lowercased, so lookup is case-insensitive. Some
    /// tools get two entries on purpose: the event normalizer is mid-rewrite
    /// from raw camelCase titles (`ToolSearch`, `TaskCreate`) to sentence-case
    /// prose (`Tool search`, `Create task`) for the same tool, and the two
    /// spellings differ by more than casing, so lowercasing alone can't
    /// unify them — both forms are listed by hand until the rewrite ships
    /// everywhere in the stored history.
    private static let verbs: [String: Tense] = [
        "bash": Tense(past: "Ran", present: "Running"),
        "run command": Tense(past: "Ran", present: "Running"),
        "read file": Tense(past: "Read", present: "Reading"),
        "edit file": Tense(past: "Edited", present: "Editing"),
        "write file": Tense(past: "Wrote", present: "Writing"),
        // codex reports every file mutation under this one title, with
        // nothing in the title itself to say created vs. edited vs. deleted —
        // "Changed" is the one verb that stays honest for all three.
        "file change": Tense(past: "Changed", present: "Changing"),
        "search code": Tense(past: "Searched", present: "Searching"),
        "find files": Tense(past: "Found", present: "Finding"),
        "list files": Tense(past: "Listed", present: "Listing"),
        "web search": Tense(past: "Searched the web", present: "Searching the web"),
        "fetch page": Tense(past: "Fetched", present: "Fetching"),
        // The run's own work list, whether the agent's todo tool or Inter's
        // task tracking. Create and update share a verb on purpose: to a
        // reader scanning the trace both are the same event — "the plan
        // changed" — and splitting them would spend two verbs to say one
        // thing. The agent's todo tool is the same event from the agent's
        // side, so it gets the same verb.
        "todo list": Tense(past: "Planned", present: "Planning"),
        "plan update": Tense(past: "Planned", present: "Planning"),
        "taskcreate": Tense(past: "Planned", present: "Planning"),
        "create task": Tense(past: "Planned", present: "Planning"),
        "taskupdate": Tense(past: "Planned", present: "Planning"),
        "update task": Tense(past: "Planned", present: "Planning"),
        "subagent": Tense(past: "Delegated", present: "Delegating"),
        // A skill is a playbook the agent consults, not a magic wand; "Loaded"
        // states what happened without pretending the skill did the work.
        "skill": Tense(past: "Loaded", present: "Loading"),
        "apply patch": Tense(past: "Applied", present: "Applying"),
        "tool search": Tense(past: "Searched", present: "Searching"),
        "toolsearch": Tense(past: "Searched", present: "Searching"),
        "list permissions": Tense(past: "Listed", present: "Listing"),
        // codex's REPL call. It is code execution, like Bash, but a reader
        // scanning shells apart from scripts benefits from its own word
        // rather than borrowing the command's.
        "node repl: js": Tense(past: "Evaluated", present: "Evaluating"),
    ]

    /// The verb for a work row's title, or nil when the row should keep its
    /// text. `live` picks the tense: present while the run is still moving,
    /// past once it settles.
    static func verb(title: String, live: Bool) -> String? {
        guard let tense = verbs[title.lowercased()] else { return nil }
        return live ? tense.present : tense.past
    }

    static func verb(for event: TaskEventSnapshot, live: Bool) -> String? {
        verb(title: event.title, live: live)
    }

    /// The glyph for a work row's title, or nil when the row should keep its
    /// text. Everything with a known verb above renders as a word; this rule
    /// is the one survivor, because an MCP call has no fixed vocabulary to
    /// name — the server can be anything a user has installed, and a verb
    /// would be a guess. `kind` gates it: every MCP-shaped title seen in the
    /// stored history arrived as a `"tool"` event, while a `"file"` or
    /// `"command"` row already carries its own path or command line as
    /// evidence — guessing a tool glyph there would trade real information
    /// for a generic one.
    static func symbolName(title: String, kind: String) -> String? {
        guard kind == "tool", isMCPShaped(title) else { return nil }
        return "wrench.adjustable"
    }

    static func symbolName(for event: TaskEventSnapshot) -> String? {
        symbolName(title: event.title, kind: event.kind)
    }

    /// An MCP call's title is `<server> <function>` or `<server>: <function>`
    /// — the server can be anything a user has installed, so there is no
    /// fixed vocabulary to match against, only a shape: two or more Title
    /// Case words, joined by a space or a colon. This app's own titles never
    /// take that shape — they are sentence case, capitalizing only their
    /// first word ("Web search", "Search code") — so the verb table above is
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
/// visual size. The box edge is the size the trace's signal marks and the
/// MCP fallback glyph (callout, 12 pt) already read at, plus a little room
/// so tall glyphs like `text.book.closed` shrink into the box instead of
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
