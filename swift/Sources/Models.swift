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
        case .pi: "pi"
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
}

struct TaskSnapshot: Codable, Identifiable, Hashable {
    var id: String
    var profileId: String
    var model: String
    var prompt: String
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
    /// The text actually sent to the provider: the caller's prompt plus this
    /// cwd's memories and the protocol wrapper.
    var shippedPrompt: String?
    /// Scope grant this run inherited. Absent means it fell back to the whole tree.
    var grantId: String?
    var costUsd: Double?
    var turns: Int?
    var archivedAt: String?

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
}

struct TaskEventSnapshot: Codable, Identifiable, Hashable {
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

struct TaskEventPresentationSnapshot: Codable, Hashable {
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

struct TaskEventPage: Codable {
    var events: [TaskEventSnapshot]
    var cursor: Int
    var hasMore: Bool
}

struct BrokerState: Codable {
    var profiles: [Profile]
    var tasks: [TaskSnapshot]
    /// Why a provider is being avoided right now.
    var profileFailures: [ProfileFailureSnapshot]
    /// What each working directory has been approved to expose.
    var grants: [ScopeGrantSnapshot]
    /// How much memory each project holds. Optional so a broker predating the
    /// field still decodes instead of blanking the whole window.
    var memoryProjects: [MemoryProjectSnapshot]?
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

struct ScopeGrantSnapshot: Codable, Identifiable, Hashable {
    var id: String
    var cwd: String
    /// Destination the scope was approved for. Empty on grants predating
    /// per-destination approval, which other profiles borrow rather than own.
    var profileId: String
    var scope: TaskScopeSnapshot
    var createdAt: String
    var lastUsedAt: String
    var useCount: Int
}

struct TaskScopeSnapshot: Codable, Hashable {
    var read: [String]
    var write: [String]
}
