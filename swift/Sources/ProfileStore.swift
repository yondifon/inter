import Foundation
import Observation

@Observable
@MainActor
final class ProfileStore {
    var profiles: [Profile] = []
    var tasks: [TaskSnapshot] = []
    var memoryProjects: [MemoryProjectSnapshot] = []
    private var polling: Task<Void, Never>?

    func start() {
        polling?.cancel()
        polling = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func refresh() async {
        do {
            var components = URLComponents(url: InterServer.api("state"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "archived", value: "include")]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let state = try JSONDecoder().decode(BrokerState.self, from: data)
            profiles = state.profiles
            tasks = state.tasks
            memoryProjects = state.memoryProjects ?? []
        } catch {}
    }

    func save(_ profile: Profile, isNew: Bool) async throws {
        let url = isNew
            ? InterServer.api("profiles")
            : InterServer.api("profiles/\(profile.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profile.id)")
        var request = URLRequest(url: url)
        request.httpMethod = isNew ? "POST" : "PUT"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(profile)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode ?? 500 < 300 else {
            throw CocoaError(.fileWriteUnknown)
        }
        await refresh()
    }

    func delete(_ profile: Profile) async {
        let id = profile.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profile.id
        var request = URLRequest(url: InterServer.api("profiles/\(id)"))
        request.httpMethod = "DELETE"
        _ = try? await URLSession.shared.data(for: request)
        await refresh()
    }

    func setArchived(_ task: TaskSnapshot, _ archived: Bool) async -> Bool {
        let id = task.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? task.id
        var request = URLRequest(url: InterServer.api("tasks/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["archived": archived])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return false
            }
            await refresh()
            return true
        } catch {
            return false
        }
    }

    /// Stops a task and its worker process tree. The reason is stored as the
    /// task error; omitted, the broker falls back to its own default.
    func cancelTask(_ task: TaskSnapshot, reason: String? = nil) async -> Bool {
        let id = task.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? task.id
        var components = URLComponents(url: InterServer.api("tasks/\(id)"), resolvingAgainstBaseURL: false)!
        if let reason {
            components.queryItems = [URLQueryItem(name: "reason", value: reason)]
        }
        guard let url = components.url else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return false
            }
            await refresh()
            return true
        } catch {
            return false
        }
    }

    /// Restarts a failed, cancelled, or blocked task in its original session.
    /// An instruction is handed to the worker at the head of the continued
    /// session; nil continues exactly where the run stopped.
    func resumeTask(_ task: TaskSnapshot, instruction: String? = nil) async -> Bool {
        let id = task.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? task.id
        var request = URLRequest(url: InterServer.api("tasks/\(id)/resume"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: instruction.map { ["instruction": $0] } ?? [:])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 202 else {
                return false
            }
            await refresh()
            return true
        } catch {
            return false
        }
    }

    /// One project's memories in full. Off the poll: values run to 16k characters
    /// each, so they are read only when a project is on screen.
    func memories(cwd: String) async -> [MemorySnapshot] {
        var components = URLComponents(url: InterServer.api("memories"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "cwd", value: cwd)]
        guard let url = components.url else { return [] }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return []
            }
            return try JSONDecoder().decode(MemoryList.self, from: data).memories
        } catch {
            return []
        }
    }
}
