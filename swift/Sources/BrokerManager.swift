import Foundation
import Observation

struct BrokerHealth: Codable, Sendable {
    var status: String
    var version: String
    var mcpContractVersion: Int
    var build: String
}

@Observable
@MainActor
final class BrokerManager {
    enum Status { case starting, running, stopped }
    private(set) var status: Status = .stopped
    private var process: Process?

    func start() {
        guard process?.isRunning != true, let spec = resolveServer() else {
            if process?.isRunning != true { status = .stopped }
            return
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: spec.executable)
        child.arguments = spec.arguments
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = loginShellPath() ?? env["PATH"]
        env["INTER_DB"] = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".inter/inter.db").path
        env["INTER_ROOTS"] = FileManager.default.homeDirectoryForCurrentUser.path
        child.environment = env
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.status = .stopped }
        }
        do {
            try child.run()
            process = child
            status = .starting
            checkReady()
        } catch {
            status = .stopped
        }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
        status = .stopped
    }

    private func checkReady() {
        Task {
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(350))
                if await healthReachable() {
                    status = .running
                    return
                }
            }
            // A slow broker start can outlast the fast window. While the process
            // is still alive, keep probing on a slower cadence instead of giving
            // up — the indicator must not stay red while everything works. If the
            // process dies, the termination handler flips `.stopped` itself.
            while process?.isRunning == true {
                try? await Task.sleep(for: .seconds(2))
                if await healthReachable() {
                    status = .running
                    return
                }
            }
            status = .stopped
        }
    }

    private func healthReachable() async -> Bool {
        guard let url = URL(string: "\(InterServer.baseURL)/health") else { return false }
        return (try? await URLSession.shared.data(from: url)) != nil
    }

    func fetchHealth() async -> BrokerHealth? {
        guard let url = URL(string: "\(InterServer.baseURL)/health") else { return nil }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(BrokerHealth.self, from: data)
        } catch {
            return nil
        }
    }

    private func resolveServer() -> (executable: String, arguments: [String])? {
        if let resources = Bundle.main.resourcePath {
            let bundled = (resources as NSString).appendingPathComponent("inter-server")
            if FileManager.default.fileExists(atPath: bundled) { return (bundled, ["serve"]) }
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = root.appendingPathComponent("src/cli.ts").path
        guard FileManager.default.fileExists(atPath: source), let bun = findBun() else { return nil }
        return (bun, ["run", source, "serve"])
    }

    private func findBun() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
            .first { FileManager.default.fileExists(atPath: $0) }
    }

    // Sentinels, not the raw output: rc files print banners, and a banner
    // concatenated into PATH breaks every lookup the broker makes. The broker
    // re-reads the login PATH itself when a worker CLI fails to resolve, so this
    // only spares it that cost in the common case.
    private func loginShellPath() -> String? {
        let start = "__INTER_PATH__"
        let end = "__INTER_END__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        process.arguments = ["-lic", "printf '\(start)%s\(end)' \"$PATH\""]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        guard let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8),
              let opening = output.range(of: start),
              let closing = output.range(of: end, range: opening.upperBound..<output.endIndex)
        else { return nil }
        let value = String(output[opening.upperBound..<closing.lowerBound])
        return value.isEmpty ? nil : value
    }
}
