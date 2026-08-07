import Foundation

enum Provider: String, Codable, CaseIterable, Identifiable {
    case claude, codex, opencode, antigravity, pi
    var id: String { rawValue }
    var label: String { rawValue == "opencode" ? "OpenCode" : rawValue.capitalized }
    var defaultModel: String {
        switch self {
        case .claude: "sonnet"
        case .codex: "gpt-5"
        case .opencode: "opencode/big-pickle"
        case .antigravity: "gemini-3.6-flash-medium"
        // pi resolves a bare id against the first catalog entry that matches it,
        // so the provider-qualified form is the only unambiguous spelling.
        case .pi: "opencode-go/deepseek-v4-flash"
        }
    }
    var symbol: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "terminal"
        case .opencode: "chevron.left.forwardslash.chevron.right"
        case .antigravity: "arrow.up.right"
        // The `pi` glyph is SF Symbols 2024.3, so it draws nothing at all below
        // macOS 15.4 — and this app ships to macOS 14. A symbol that silently
        // renders blank is worse than a plainer one that always draws, so the
        // letter form only appears where it exists.
        case .pi:
            if #available(macOS 15.4, *) { "pi" } else { "function" }
        }
    }

    /// Interactive continuation of a captured session, for a human to paste into a
    /// terminal. Not the headless form the broker spawns — that one carries the
    /// stream flags and a prompt. Antigravity records no session, so it has none.
    func resumeCommand(session: String) -> String? {
        switch self {
        case .claude: "claude --resume \(session)"
        case .codex: "codex resume \(session)"
        case .opencode: "opencode --session \(session)"
        case .antigravity: nil
        // Exact id, no picker and no fork prompt — but pi looks sessions up per
        // directory, so this only reopens it from the task's own cwd.
        case .pi: "pi --session-id \(session)"
        }
    }
}

struct Profile: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var provider: Provider
    var model: String?
    var enabled: Bool
    var env: [String: String]
    var capabilities: [String]
    var command: [String]?

    static var empty: Profile {
        Profile(id: "", label: "", provider: .claude, model: nil,
                enabled: true, env: [:], capabilities: ["build", "review"])
    }

    var resolvedModel: String { model ?? provider.defaultModel }

    /// The provider's resume line with this profile's env assignments in front —
    /// a pinned config dir is where the sessions actually live, so the bare line
    /// would reopen the wrong context. Empty env leaves the line unchanged.
    func resumeCommand(session: String) -> String? {
        guard let command = provider.resumeCommand(session: session) else { return nil }
        let prefix = env.sorted { $0.key < $1.key }
            .map { "\($0.key)=\(shellAssignment($0.value))" }
            .joined(separator: " ")
        return prefix.isEmpty ? command : "\(prefix) \(command)"
    }
}

/// Bare when the value is one safe word, double-quoted otherwise. Quotes must
/// not defeat `$HOME` expansion — a pinned config dir usually starts with it.
private func shellAssignment(_ value: String) -> String {
    value.range(of: #"[^A-Za-z0-9_~$./:@%,=+-]"#, options: .regularExpression) == nil
        ? value
        : "\"\(value)\""
}

/// What paths a run may read and write. Mirrors the broker's `TaskScope`.
struct TaskScope: Codable, Hashable, Sendable {
    var read: [String]
    var write: [String]
}

/// How a run ended when it did not land clean. Absent on tasks predating the
/// field.
struct TaskCompletion: Codable, Hashable, Sendable {
    var blocked: Bool
    var code: String
    var reason: String?
    /// Present only when `code == "permission_denied"`: the scope that would
    /// have let the run finish. Apply verbatim on resume.
    var suggestedScope: TaskScope?
}

struct TaskSnapshot: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var profileId: String
    var model: String
    /// Reasoning level the run was dispatched with. Absent when no level was set.
    var effort: String? = nil
    var prompt: String
    /// Caller's one-line plain-language summary, written for the list where the
    /// full prompt is too long. Absent on tasks predating the field.
    var tldr: String? = nil
    /// Short human label, max 60 chars. Absent on tasks predating the field.
    var title: String? = nil
    var cwd: String
    var state: String
    var createdAt: String
    var updatedAt: String
    var output: String
    var error: String?
    var question: String?
    var parentTaskId: String?
    /// Provider-native worker session. Copy this into the provider CLI when a
    /// task must be resumed outside Inter.
    var sessionId: String?
    var costUsd: Double?
    var turns: Int?
    var archivedAt: String?
    /// What this run may read and write. Absent on tasks predating the field.
    var scope: TaskScope?
    /// How the run ended, when it did not land clean. Absent while a task is
    /// still live, and on tasks predating the field.
    var completion: TaskCompletion?

    /// `opencode/big-pickle` reads as `big-pickle` in a list where the worker name
    /// beside it already says which provider ran it.
    var shortModel: String {
        model.split(separator: "/").last.map(String.init) ?? model
    }

    /// Home-relative form of `cwd`. `/Users/name` is the same on every row, so it
    /// spends header width on nothing.
    var displayPath: String {
        (cwd as NSString).abbreviatingWithTildeInPath
    }

    /// The broker's short label when it has one, otherwise the prompt's first
    /// line. Unlike `TaskOrganizer.heading(for:)` this is not truncated —
    /// callers rely on `.lineLimit(1)` to clip.
    var displayLabel: String {
        let label = title?.trimmingCharacters(in: .whitespaces)
        guard let label, !label.isEmpty else {
            return prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Untitled task"
        }
        return label
    }

    /// Caller's one-liner when there is one, else the prompt — a row hover
    /// would otherwise show nothing for tasks predating the field.
    var hoverText: String {
        let summary = tldr?.trimmingCharacters(in: .whitespaces)
        guard let summary, !summary.isEmpty else {
            return prompt
        }
        return summary
    }
}

struct TaskEventSnapshot: Codable, Identifiable, Hashable, Sendable {
    var id: Int
    var taskId: String
    var source: String
    var kind: String
    var phase: String
    var title: String
    var detail: String?
    var presentation: TaskEventPresentationSnapshot?
    var rawText: String?
    var createdAt: String
    /// Broker-declared plumbing: folded into the technical list by default.
    var minor: Bool?
    /// Provider id shared by every event describing one action — the agent's
    /// echo, its hooks, its result. Rows carrying the same one are one action.
    var actionId: String?
}

struct TaskEventPresentationSnapshot: Codable, Hashable, Sendable {
    var type: String
    var path: String?
    var change: String?
    var command: String?
    var status: String?
    var exitCode: Int?
    var text: String?
    var completed: Int?
    var total: Int?
    var costUsd: Double?
    var tokensIn: Int?
    var tokensOut: Int?
    var tokensCached: Int?
    var tokensThinking: Int?
    var outcome: String?
    var turns: Int?
    var durationMs: Int?
    var level: String?
}

struct TaskEventPage: Codable, Sendable {
    var events: [TaskEventSnapshot]
    var cursor: Int
    var hasMore: Bool
    /// Oldest event id in this page — set on tail (`?last=N`) and `?before=<id>`
    /// responses. Absent on the legacy `after` long-poll path.
    var oldestId: Int?
    /// True when older events exist before `oldestId`. Absent on legacy paths.
    var hasEarlier: Bool?
}

struct BrokerState: Codable {
    var profiles: [Profile]
    var tasks: [TaskSnapshot]
    /// How much memory each project holds. Optional so a broker predating the
    /// field still decodes instead of blanking the whole window.
    var memoryProjects: [MemoryProjectSnapshot]?
}

/// Lightweight task row for the sidebar poll. The broker returns this shape
/// from `GET /api/state?view=summary` — every field the sidebar needs, none
/// of the payload it doesn't (no prompt, output, or attempts).
struct TaskListItem: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var profileId: String
    var model: String
    var cwd: String
    var state: String
    /// First line or so of the prompt — enough to label a row, not the full text.
    var promptPreview: String
    var tldr: String?
    var title: String?
    var createdAt: String
    var updatedAt: String
    var error: String?
    var question: String?
    var parentTaskId: String?
    var grantId: String?
    var costUsd: Double?
    var archivedAt: String?
    /// How the run ended, when it did not land clean. Absent while a task is
    /// still live, and on tasks predating the field.
    var completion: TaskCompletion?

    var shortModel: String {
        model.split(separator: "/").last.map(String.init) ?? model
    }

    var displayPath: String {
        (cwd as NSString).abbreviatingWithTildeInPath
    }

    var displayLabel: String {
        let label = title?.trimmingCharacters(in: .whitespaces)
        guard let label, !label.isEmpty else {
            return promptPreview.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Untitled task"
        }
        return label
    }

    var hoverText: String {
        let summary = tldr?.trimmingCharacters(in: .whitespaces)
        guard let summary, !summary.isEmpty else {
            return promptPreview
        }
        return summary
    }
}

/// Same envelope as `BrokerState` but tasks are `TaskListItem` instead of
/// `TaskSnapshot` — decoded from the summary poll.
struct BrokerSummaryState: Codable, Sendable {
    var profiles: [Profile]
    var tasks: [TaskListItem]
    /// Whether `tasks` was truncated by the requested `limit` — absent on a
    /// broker predating paging, which reads as "no known next page".
    var tasksHasMore: Bool?
    var memoryProjects: [MemoryProjectSnapshot]?
    var spend: SpendTotals?
}

/// Cost and tokens summed over the broker's trailing window — absent on a
/// broker predating this field, hence optional everywhere it is read.
struct SpendTotals: Codable, Equatable, Sendable {
    var costUsd: Double
    var tokens: Int
    var since: String
    /// Finished tasks whose provider never reported a price, which makes the
    /// total a floor. Absent on a broker predating this field.
    var unpricedTasks: Int?

    /// `$1.24 · 847k` for the sidebar footer. Nil when the window saw no
    /// activity at all — an ambient "$0.00 · 0" next to the broker dot would
    /// read as broken, not calm.
    var summary: String? {
        guard costUsd > 0 || tokens > 0 else { return nil }
        let cost = ActivityFormat.cost(costUsd)
        let floor = (unpricedTasks ?? 0) > 0 ? "\(cost)+" : cost
        return "\(floor) · \(ActivityFormat.count(tokens))"
    }

    /// What the footer says on hover. A trailing `+` is only honest if something
    /// says what it stands for.
    var detail: String? {
        guard let summary = summary else { return nil }
        let window = "\(summary) over the last 24 hours"
        guard let unpriced = unpricedTasks, unpriced > 0 else { return window }
        let tasks = unpriced == 1 ? "1 task" : "\(unpriced) tasks"
        return "\(window) · cost unknown for \(tasks)"
    }
}

/// One project's memory footprint. The values themselves stay on the broker
/// until the project is opened.
struct MemoryProjectSnapshot: Codable, Identifiable, Hashable {
    var id: String { cwd }
    var cwd: String
    var count: Int
    var chars: Int
    var updatedAt: String

    var name: String { (cwd as NSString).lastPathComponent }
}

struct MemorySnapshot: Codable, Identifiable, Hashable {
    /// Keys are unique within a cwd, and a list only ever covers one.
    var id: String { key }
    var cwd: String
    var key: String
    var value: String
    var version: Int
    var createdAt: String
    var updatedAt: String
}

struct MemoryList: Codable {
    var memories: [MemorySnapshot]
}

struct ProfileFailureSnapshot: Codable, Identifiable, Hashable {
    var id: String { profileId }
    var profileId: String
    var code: String
    var message: String
    var failedAt: String
    var consecutiveFailures: Int
    var retryAt: String?
}

/// Pure merge helpers for the Activity event stream. Events always arrive
/// ascending by id; callers verify that invariant and fall back to a full sort
/// when a batch lands out of order.
enum EventMerge {
    /// Filters out ids already present, then returns the remainder only when it
    /// can be appended without breaking order: internally ascending and every id
    /// past the last existing one. A duplicate is fine — page boundaries repeat
    /// an id — but a genuinely new id inside the existing range means the stream
    /// jumped, so the empty return tells the caller to fall back to a full sort.
    static func appendInOrder(_ incoming: [TaskEventSnapshot], after existing: [TaskEventSnapshot]) -> [TaskEventSnapshot] {
        var known = Set(existing.map(\.id))
        let fresh = incoming.filter { known.insert($0.id).inserted }
        guard !fresh.isEmpty, ascending(fresh) else { return [] }
        if let lastExisting = existing.last, fresh[0].id < lastExisting.id {
            return []
        }
        return fresh
    }

    /// Mirror of `appendInOrder` for paging backward: the remainder must be
    /// internally ascending and sit entirely before the first existing id.
    static func prependInOrder(_ incoming: [TaskEventSnapshot], before existing: [TaskEventSnapshot]) -> [TaskEventSnapshot] {
        var known = Set(existing.map(\.id))
        let fresh = incoming.filter { known.insert($0.id).inserted }
        guard !fresh.isEmpty, ascending(fresh) else { return [] }
        if let firstExisting = existing.first, fresh[fresh.count - 1].id > firstExisting.id {
            return []
        }
        return fresh
    }

    private static func ascending(_ events: [TaskEventSnapshot]) -> Bool {
        zip(events, events.dropFirst()).allSatisfy { $0.id < $1.id }
    }
}
