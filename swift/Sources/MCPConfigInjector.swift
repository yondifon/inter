import Foundation

enum MCPClient: String, CaseIterable, Identifiable {
    case codex, claude, opencode, antigravity
    var id: String { rawValue }
    var label: String { rawValue == "opencode" ? "OpenCode" : rawValue.capitalized }
}

enum MCPConfigInjector {
    struct InstallResult {
        var client: String
        var path: String
        var success: Bool
        var message: String
    }

    static func installEverywhere(profiles: [Profile]) -> [InstallResult] {
        var targets: [(MCPClient, String)] = [
            (.codex, "~/.codex/config.toml"),
            (.claude, "~/.claude.json"),
            (.opencode, "~/.config/opencode/opencode.json"),
            (.antigravity, "~/.gemini/config/mcp_config.json"),
        ]
        for profile in profiles where profile.provider == .claude && profile.enabled {
            if let dir = profile.env["CLAUDE_CONFIG_DIR"] {
                targets.append((.claude, "\(dir)/.claude.json"))
            }
        }
        return targets.map { client, rawPath in
            let path = expand(rawPath)
            do {
                if client == .codex { try installCodex(path: path) }
                else { try installJSON(client: client, path: path) }
                return InstallResult(client: client.label, path: pretty(path), success: true, message: "Installed")
            } catch {
                return InstallResult(client: client.label, path: pretty(path), success: false, message: error.localizedDescription)
            }
        }
    }

    private static func installCodex(path: String) throws {
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        let header = "[mcp_servers.inter]"
        let block = "\(header)\nurl = \"\(InterServer.mcpURL)\""
        let lines = existing.components(separatedBy: .newlines)
        var output: [String] = []
        var skipping = false
        var replaced = false
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == header {
                output.append(block)
                skipping = true
                replaced = true
                continue
            }
            if skipping && trimmed.hasPrefix("[") {
                skipping = false
            }
            if !skipping { output.append(line) }
        }
        if !replaced {
            if !output.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                output.append("")
            }
            output.append(block)
        }
        try backupAndWrite(path: path, text: output.joined(separator: "\n").trimmingCharacters(in: .newlines) + "\n")
    }

    private static func installJSON(client: MCPClient, path: String) throws {
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? "{}"
        guard let data = sanitizeJSONC(existing).data(using: .utf8),
              var root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw NSError(domain: "Inter", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn’t parse existing config."])
        }
        let container = client == .opencode ? "mcp" : "mcpServers"
        var servers = root[container] as? [String: Any] ?? [:]
        switch client {
        case .claude: servers["inter"] = ["type": "http", "url": InterServer.mcpURL]
        case .opencode: servers["inter"] = ["type": "remote", "enabled": true, "url": InterServer.mcpURL, "oauth": false]
        case .antigravity: servers["inter"] = ["serverUrl": InterServer.mcpURL]
        case .codex: break
        }
        root[container] = servers
        let encoded = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try backupAndWrite(path: path, text: String(decoding: encoded, as: UTF8.self) + "\n")
    }

    private static func backupAndWrite(path: String, text: String) throws {
        let manager = FileManager.default
        try manager.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if manager.fileExists(atPath: path) {
            let backup = path + ".bak"
            try? manager.removeItem(atPath: backup)
            try manager.copyItem(atPath: path, toPath: backup)
        }
        try Data(text.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    private static func sanitizeJSONC(_ text: String) -> String {
        var output = ""
        var inString = false
        var escaped = false
        var index = text.startIndex
        while index < text.endIndex {
            let char = text[index]
            let next = text.index(after: index)
            if inString {
                output.append(char)
                if escaped { escaped = false }
                else if char == "\\" { escaped = true }
                else if char == "\"" { inString = false }
                index = next
                continue
            }
            if char == "\"" { inString = true; output.append(char); index = next; continue }
            if char == "/", next < text.endIndex, text[next] == "/" {
                index = text.index(after: next)
                while index < text.endIndex, text[index] != "\n" { index = text.index(after: index) }
                continue
            }
            output.append(char)
            index = next
        }
        return output.replacingOccurrences(of: #",\s*([}\]])"#, with: "$1", options: .regularExpression)
    }

    private static func expand(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.replacingOccurrences(of: "$HOME", with: home)
            .replacingOccurrences(of: "~", with: home, options: .anchored)
    }

    private static func pretty(_ path: String) -> String {
        path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~", options: .anchored)
    }
}
