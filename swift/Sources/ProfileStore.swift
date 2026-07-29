import Foundation
import Observation

@Observable
@MainActor
final class ProfileStore {
    var profiles: [Profile] = []
    var tasks: [TaskSnapshot] = []
    var settings = BrokerSettings(dynamicProfileTools: false)
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
            let (data, response) = try await URLSession.shared.data(from: InterServer.api("state"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let state = try JSONDecoder().decode(BrokerState.self, from: data)
            profiles = state.profiles
            tasks = state.tasks
            settings = state.settings
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

    func setDynamicProfileTools(_ enabled: Bool) async {
        var request = URLRequest(url: InterServer.api("settings"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONEncoder().encode(BrokerSettings(dynamicProfileTools: enabled))
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                self.error = "Couldn’t update MCP tools"
                return
            }
            await refresh()
        } catch {
            self.error = "Couldn’t update MCP tools"
        }
    }
}
