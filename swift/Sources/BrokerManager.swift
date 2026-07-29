import Foundation
import Observation

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
        env["INTER_CONFIG"] = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".inter/inter.config.json").path
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
                if let url = URL(string: "\(InterServer.baseURL)/health"),
                   (try? await URLSession.shared.data(from: url)) != nil {
                    status = .running
                    return
                }
            }
            status = .stopped
        }
    }

    private func resolveServer() -> (executable: String, arguments: [String])? {
        if let resources = Bundle.main.resourcePath {
            let bundled = (resources as NSString).appendingPathComponent("inter-server")
            if FileManager.default.fileExists(atPath: bundled) { return (bundled, []) }
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = root.appendingPathComponent("src/cli.ts").path
        guard FileManager.default.fileExists(atPath: source), let bun = findBun() else { return nil }
        return (bun, ["run", source])
    }

    private func findBun() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
            .first { FileManager.default.fileExists(atPath: $0) }
    }

    private func loginShellPath() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        process.arguments = ["-lic", "printf %s \"$PATH\""]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}
