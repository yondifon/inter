import Foundation
import Observation

@Observable
@MainActor
final class ProfileStore {
    /// Rows fetched per page, and per additional "Load more" click. Small
    /// enough that the steady 2-second poll stays cheap even after several
    /// pages are loaded; generous enough that a normal day of tasks fits on
    /// one page and never needs the control at all.
    static let taskPageSize = 50

    var profiles: [Profile] = []
    var tasks: [TaskListItem] = []
    /// Whether the broker has rows beyond what's currently loaded, for the
    /// current archive filter. Drives whether "Load more" shows at all.
    var tasksHasMore = false
    /// Set when a "Load more" fetch specifically fails, so the control can
    /// offer a retry instead of doing nothing. Cleared by the next successful
    /// fetch, load-more or background poll alike.
    var loadMoreFailed = false
    private(set) var isLoadingMoreTasks = false
    var memoryProjects: [MemoryProjectSnapshot] = []
    var spend: SpendTotals?
    private var polling: Task<Void, Never>?
    private var loadedPages = 1
    private var archiveFilter: TaskArchiveFilter = .active

    func start(archiveFilter: TaskArchiveFilter) {
        self.archiveFilter = archiveFilter
        polling?.cancel()
        polling = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Switches which archive state the sidebar shows. A different filter is a
    /// different result set to page through, so this resets to the first page
    /// and refetches immediately instead of waiting for the next poll tick.
    func setArchiveFilter(_ filter: TaskArchiveFilter) async {
        guard filter != archiveFilter else { return }
        archiveFilter = filter
        loadedPages = 1
        loadMoreFailed = false
        await refresh()
    }

    /// Fetches one more page for the current filter. A no-op while a page is
    /// already loading or the broker has already said there is nothing more.
    func loadMoreTasks() async {
        guard tasksHasMore, !isLoadingMoreTasks else { return }
        isLoadingMoreTasks = true
        loadedPages += 1
        let succeeded = await refresh()
        isLoadingMoreTasks = false
        loadMoreFailed = !succeeded
        // A failed fetch didn't grow what's on screen, so a retry should
        // re-ask for the same page rather than skip past it.
        if !succeeded { loadedPages -= 1 }
    }

    /// Fetches the current filter's loaded window — one page on first load,
    /// more once "Load more" has grown `loadedPages`. Returns whether the
    /// fetch itself succeeded, so `loadMoreTasks` can tell a real failure
    /// apart from "nothing changed".
    @discardableResult
    func refresh() async -> Bool {
        do {
            var components = URLComponents(url: InterServer.api("state"), resolvingAgainstBaseURL: false)!
            components.queryItems = [
                URLQueryItem(name: "view", value: "summary"),
                URLQueryItem(name: "archived", value: archiveFilter.rawValue),
                URLQueryItem(name: "limit", value: String(loadedPages * Self.taskPageSize)),
            ]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            // Decode off the MainActor so a large payload never stalls the UI.
            let state = try await Task.detached { () -> BrokerSummaryState in
                try JSONDecoder().decode(BrokerSummaryState.self, from: data)
            }.value
            // Assign only when the decoded value differs — no wholesale
            // reassignment every poll tick.
            if state.profiles != profiles { profiles = state.profiles }
            if state.tasks != tasks { tasks = state.tasks }
            tasksHasMore = state.tasksHasMore ?? false
            let projects = state.memoryProjects ?? []
            if projects != memoryProjects { memoryProjects = projects }
            if state.spend != spend { spend = state.spend }
            return true
        } catch {
            return false
        }
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

    /// Marks a stuck non-final task completed from the sidebar. The broker
    /// stops a still-running worker first, then records the assertion.
    func markTaskCompleted(_ id: String) async -> Bool {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = URLRequest(url: InterServer.api("tasks/\(encoded)/complete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "assertedBy": "Inter app",
            "reason": "marked completed from the sidebar",
        ])
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

    /// Continues a task in its original session — retrying a failed, cancelled
    /// or blocked run, or following up on a completed one. An instruction is
    /// handed to the worker at the head of the continued session; nil continues
    /// exactly where the run stopped, which the broker allows only for a run
    /// that did not complete. A scope replaces the run's existing one — used to
    /// approve a `suggestedScope` after a sandbox denial.
    func resumeTask(_ id: String, instruction: String? = nil, scope: TaskScope? = nil) async -> Bool {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = URLRequest(url: InterServer.api("tasks/\(encoded)/resume"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = [:]
        if let instruction { body["instruction"] = instruction }
        if let scope {
            body["scope"] = ["read": scope.read, "write": scope.write]
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
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
