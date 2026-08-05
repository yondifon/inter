import Foundation
import Observation

@Observable
@MainActor
final class ProfileStore {
    var profiles: [Profile] = []
    var tasks: [TaskListItem] = []
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
            components.queryItems = [
                URLQueryItem(name: "view", value: "summary"),
                URLQueryItem(name: "archived", value: "include"),
            ]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            // Decode off the MainActor so a large payload never stalls the UI.
            let state = try await Task.detached { () -> BrokerSummaryState in
                try JSONDecoder().decode(BrokerSummaryState.self, from: data)
            }.value
            // Assign only when the decoded value differs — no wholesale
            // reassignment every poll tick.
            if state.profiles != profiles { profiles = state.profiles }
            if state.tasks != tasks { tasks = state.tasks }
            let projects = state.memoryProjects ?? []
            if projects != memoryProjects { memoryProjects = projects }
        } catch {}
    }

    /// Fetches the full task row for the detail pane. Nil when the task is
    /// unknown or the broker is unreachable.
    func taskDetail(id: String) async -> TaskSnapshot? {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let url = InterServer.api("tasks/\(encoded)")
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(TaskSnapshot.self, from: data)
        } catch {
            return nil
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

    func delete(_ profile: Profile) async -> Bool {
        let id = profile.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profile.id
        var request = URLRequest(url: InterServer.api("profiles/\(id)"))
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

    func setArchived(_ id: String, _ archived: Bool) async -> Bool {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = URLRequest(url: InterServer.api("tasks/\(encoded)"))
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
    func cancelTask(_ id: String, reason: String? = nil) async -> Bool {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var components = URLComponents(url: InterServer.api("tasks/\(encoded)"), resolvingAgainstBaseURL: false)!
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
    func resumeTask(_ id: String, instruction: String? = nil) async -> Bool {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = URLRequest(url: InterServer.api("tasks/\(encoded)/resume"))
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
