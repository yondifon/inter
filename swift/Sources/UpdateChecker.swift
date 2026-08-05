import Foundation
import Observation

/// Source-build updater. The bundle carries the commit it was built from
/// (`InterBuildCommit`) and the source checkout it was built in (`InterRepoPath`)
/// — both baked into Info.plist by `make bundle`. A check compares the built
/// commit against the remote default branch (`git ls-remote origin HEAD`);
/// installing pulls the checkout and re-runs `make install`, which quits,
/// replaces, and relaunches the app. Dev runs (`swift run`) have no Info.plist,
/// so the checker stays disabled there.
@Observable
@MainActor
final class UpdateChecker {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case updateAvailable(commit: String)
        case updating
        case failed(String)
    }

    private(set) var state: State = .idle

    static let updateLogPath = "/tmp/inter-update.log"

    static let buildCommit = Bundle.main.object(forInfoDictionaryKey: "InterBuildCommit") as? String
    static let repoPath = Bundle.main.object(forInfoDictionaryKey: "InterRepoPath") as? String

    /// Baked commit + a still-existing checkout; otherwise checks are meaningless.
    static var isConfigured: Bool {
        guard let commit = buildCommit, commit.count == 40,
              let repo = repoPath else { return false }
        return FileManager.default.fileExists(atPath: repo)
    }

    func startPeriodicChecks() {
        guard Self.isConfigured else { return }
        Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: .seconds(6 * 3600))
            }
        }
    }

    func check() async {
        guard Self.isConfigured,
              let buildCommit = Self.buildCommit, let repo = Self.repoPath,
              state != .checking, state != .updating else { return }
        state = .checking

        // Login shell so git resolves the user's PATH and ssh agent config —
        // a GUI launch inherits neither (same reason BrokerManager resolves PATH
        // through a login shell before starting the broker).
        let result = await Self.runShell("git -C '\(repo)' ls-remote origin HEAD")
        guard result.status == 0, let remote = Self.parseLsRemoteHead(result.output) else {
            let detail = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
            state = .failed(detail.isEmpty ? "git ls-remote failed" : detail)
            return
        }
        state = remote == buildCommit ? .upToDate : .updateAvailable(commit: remote)
    }

    /// Pull + rebuild + reinstall, detached from the app: `make install` quits
    /// this process mid-run, so the job must survive us. `nohup … &` reparents
    /// it to launchd. Progress lands in the log file; on success `make install`
    /// relaunches the app itself.
    func installUpdate() {
        guard let repo = Self.repoPath, case .updateAvailable = state else { return }
        state = .updating
        let job = "cd '\(repo)' && git pull --ff-only && make install"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-c", "nohup /bin/zsh -lc \"\(job)\" > \(Self.updateLogPath) 2>&1 &"]
        do {
            try p.run()
        } catch {
            state = .failed("Could not start update: \(error.localizedDescription)")
        }
    }

    // MARK: - Helpers

    /// First line shaped `<40-hex-sha>\tHEAD` — login shells can prepend
    /// dotfile noise, so scan rather than trust line 1.
    nonisolated private static func parseLsRemoteHead(_ output: String) -> String? {
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: "\t")
            guard parts.count == 2, parts[1].trimmingCharacters(in: .whitespaces) == "HEAD" else { continue }
            let sha = String(parts[0])
            if sha.count == 40, sha.allSatisfy(\.isHexDigit) { return sha }
        }
        return nil
    }

    nonisolated private static func runShell(_ command: String) async -> (status: Int32, output: String) {
        await withCheckedContinuation { cont in
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            let p = Process()
            p.executableURL = URL(fileURLWithPath: shell)
            p.arguments = ["-lic", command]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                cont.resume(returning: (proc.terminationStatus, String(data: data, encoding: .utf8) ?? ""))
            }
            do {
                try p.run()
            } catch {
                cont.resume(returning: (-1, error.localizedDescription))
            }
        }
    }
}
