import Foundation
import SwiftUI

/// How a file is named on screen. A run works inside one directory, so naming
/// its files from that directory is what the reader already has in their head —
/// `swift/Sources/X.swift`, not the machine's full route to it.
enum DisplayPath {
    /// The path as the reader knows it. Inside the run's directory that is the
    /// part below it; outside, the home-relative form, because a path that
    /// cannot be shortened honestly is better shown whole than trimmed to a
    /// fragment.
    static func relative(_ path: String, to cwd: String) -> String {
        let root = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        guard !root.isEmpty, path.hasPrefix("/") else { return path }
        guard path.hasPrefix(root + "/") else {
            return (path as NSString).abbreviatingWithTildeInPath
        }
        let inside = String(path.dropFirst(root.count + 1))
        return inside.isEmpty ? path : inside
    }
}

/// The directory the open task ran in, so a row deep in the trace can name its
/// files the way the reader does without every view between passing it down.
private struct TaskCwdKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var taskCwd: String {
        get { self[TaskCwdKey.self] }
        set { self[TaskCwdKey.self] = newValue }
    }
}
