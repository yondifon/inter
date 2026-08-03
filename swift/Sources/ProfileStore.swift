import Foundation
import Observation

@Observable
@MainActor
final class ProfileStore {
    var profiles: [Profile] = []
    var tasks: [TaskSnapshot] = []
    var profileFailures: [ProfileFailureSnapshot] = []
    var grants: [ScopeGrantSnapshot] = []
    var memoryProjects: [MemoryProjectSnapshot] = []
    var error: String?
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
            profileFailures = state.profileFailures
            grants = state.grants
            memoryProjects = state.memoryProjects ?? []
            error = nil
        } catch {
            self.error = "Broker unavailable"
        }
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
                self.error = "Couldn’t update task archive"
                return false
            }
            await refresh()
            return true
        } catch {
            self.error = "Couldn’t update task archive"
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
                self.error = "Couldn’t load project memories"
                return []
            }
            return try JSONDecoder().decode(MemoryList.self, from: data).memories
        } catch {
            self.error = "Couldn’t load project memories"
            return []
        }
    }

    func revokeGrant(_ id: String) async {
        var request = URLRequest(url: InterServer.api("grants/\(id)"))
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 204 else {
                self.error = "Couldn’t revoke scope grant"
                return
            }
            await refresh()
        } catch {
            self.error = "Couldn’t revoke scope grant"
        }
    }
}
