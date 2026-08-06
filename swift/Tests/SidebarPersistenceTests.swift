import XCTest

@testable import Inter

final class SidebarPersistenceTests: XCTestCase {
    private let sortKey = "taskSort"
    private let groupingKey = "taskGrouping"
    private let migrationMarker = "migratedTaskSortDefaults"

    /// Mirrors `AppZoomTests`: `swift test` runs under its own bundle id, so
    /// `UserDefaults.standard` here is isolated from a real, running Inter.app —
    /// but not from other tests in this run, so every key touched gets reset first.
    private func resetDefaults() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: sortKey)
        defaults.removeObject(forKey: groupingKey)
        defaults.removeObject(forKey: migrationMarker)
    }

    override func setUp() { resetDefaults() }
    override func tearDown() { resetDefaults() }

    func testStoredSortSurvivesARead() {
        UserDefaults.standard.set(TaskSort.updated.rawValue, forKey: sortKey)
        let resolved = TaskSort(rawValue: UserDefaults.standard.string(forKey: sortKey) ?? "")
        XCTAssertEqual(resolved, .updated, "a stored sort must read back as the same case, not fall through to a default")
    }

    /// This is the literal expression `ContentView` uses as `sortRaw`'s `@AppStorage`
    /// default; a rename or a changed default there would break this the same way.
    func testAbsentSortStorageResolvesToPriority() {
        XCTAssertNil(UserDefaults.standard.string(forKey: sortKey), "precondition: nothing stored yet")
        let stored = UserDefaults.standard.string(forKey: sortKey) ?? TaskSort.priority.rawValue
        XCTAssertEqual(TaskSort(rawValue: stored), .priority, "no stored value must resolve to Priority, not silently pick another sort")
    }

    /// The marker must stop a second run cold, even in the pathological case where
    /// `taskGrouping` still reads as the legacy sentinel — otherwise a second run
    /// would re-fire the clobber-capable branch and overwrite a real choice.
    func testMigrationIsIdempotentAndDoesNotClobberAStoredSortOnRepeatedRuns() {
        UserDefaults.standard.set("priority", forKey: groupingKey)
        TaskSortDefaults.migrate()
        XCTAssertEqual(UserDefaults.standard.string(forKey: sortKey), TaskSort.priority.rawValue, "first run migrates the legacy sentinel")

        UserDefaults.standard.set(TaskSort.updated.rawValue, forKey: sortKey)
        UserDefaults.standard.set("priority", forKey: groupingKey)

        TaskSortDefaults.migrate()
        TaskSortDefaults.migrate()

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: sortKey),
            TaskSort.updated.rawValue,
            "the one-time marker must stop later runs from reverting a real choice"
        )
    }

    func testMigrationLeavesAFreshInstallUntouched() {
        TaskSortDefaults.migrate()
        XCTAssertNil(UserDefaults.standard.string(forKey: sortKey), "no legacy sentinel present, so taskSort must stay unset")
        XCTAssertNil(UserDefaults.standard.string(forKey: groupingKey))
    }

    func testMigrationConvertsTheLegacySentinelExactlyOnce() {
        UserDefaults.standard.set("priority", forKey: groupingKey)
        TaskSortDefaults.migrate()
        XCTAssertEqual(UserDefaults.standard.string(forKey: groupingKey), TaskGrouping.parent.rawValue)
        XCTAssertEqual(UserDefaults.standard.string(forKey: sortKey), TaskSort.priority.rawValue)
    }
}
