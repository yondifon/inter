import Foundation

enum Provider: String, Codable, CaseIterable, Identifiable {
    case claude, codex, opencode, antigravity
    var id: String { rawValue }
    var label: String { rawValue == "opencode" ? "OpenCode" : rawValue.capitalized }
    var symbol: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "terminal"
        case .opencode: "chevron.left.forwardslash.chevron.right"
        case .antigravity: "arrow.up.right"
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
        }
    }
}

struct Profile: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var provider: Provider
    var model: String
    var enabled: Bool
    var env: [String: String]
    var capabilities: [String]
    var command: [String]?

    static var empty: Profile {
        Profile(id: "", label: "", provider: .claude, model: "sonnet",
                enabled: true, env: [:], capabilities: ["build", "review"])
    }
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
    var settings: BrokerSettings
}

struct BrokerSettings: Codable {
    var dynamicProfileTools: Bool
}
