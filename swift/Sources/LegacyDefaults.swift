import Foundation

/// The app shipped under `dev.inter.app` before the namespace moved to
/// `desgnspace.inter.app`. On macOS a bundle id *is* the preferences domain, so
/// the rename would quietly reset zoom, window position, and every sidebar
/// preference. One pass on first launch carries them across; the marker makes it
/// a one-time move, so a value cleared later stays cleared.
enum LegacyDefaults {
    private static let legacyDomain = "dev.inter.app"
    private static let marker = "migratedLegacyDefaults"
    private static let keys = [
        "InterUIZoomStep",
        "taskGrouping",
        "taskProjectFilter",
        "showArchivedTasks",
        "collapsedTaskGroups",
        "NSWindow Frame InterMainWindow",
    ]

    static func migrate() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: marker) else { return }
        defaults.set(true, forKey: marker)
        guard let legacy = UserDefaults(suiteName: legacyDomain) else { return }
        for key in keys where defaults.object(forKey: key) == nil {
            guard let value = legacy.object(forKey: key) else { continue }
            defaults.set(value, forKey: key)
        }
    }
}
