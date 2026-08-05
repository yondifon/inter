import SwiftUI

/// Content scale for the window, driven by View ▸ Zoom In / Zoom Out / Actual Size.
/// Reading surfaces — sidebar rows, task detail, activity trace, markdown and JSON —
/// follow this value. Native controls keep their system size so they never clip.
@MainActor
@Observable
final class AppZoom {
    static let steps: [CGFloat] = [0.85, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0]
    private static let defaultIndex = 2
    private static let key = "InterUIZoomStep"

    private var index: Int {
        didSet { UserDefaults.standard.set(index, forKey: Self.key) }
    }

    init() {
        let stored = UserDefaults.standard.object(forKey: Self.key) as? Int
        index = (stored?.clamped(to: Self.steps.indices)) ?? Self.defaultIndex
    }

    var scale: CGFloat { Self.steps[index] }
    var canZoomIn: Bool { index < Self.steps.count - 1 }
    var canZoomOut: Bool { index > 0 }
    var isDefault: Bool { index == Self.defaultIndex }

    /// Percentage shown in the menu so the current scale is never a guess.
    var label: String { "\(Int((scale * 100).rounded()))%" }

    func zoomIn() { if canZoomIn { index += 1 } }
    func zoomOut() { if canZoomOut { index -= 1 } }
    func reset() { index = Self.defaultIndex }
}

private extension Int {
    func clamped(to range: Range<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound - 1)
    }
}

/// Applies the current zoom to the SwiftUI tree hosted by the AppKit window.
struct RootView: View {
    let store: ProfileStore
    let broker: BrokerManager
    let zoom: AppZoom
    let updateChecker: UpdateChecker
    let openSettings: () -> Void

    var body: some View {
        ContentView(store: store, broker: broker, updateChecker: updateChecker, openSettings: openSettings)
            .environment(\.uiScale, zoom.scale)
    }
}
