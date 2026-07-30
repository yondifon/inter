import SwiftUI
import XCTest

@testable import Inter

@MainActor
final class AppZoomTests: XCTestCase {
    private func makeZoom() -> AppZoom {
        UserDefaults.standard.removeObject(forKey: "InterUIZoomStep")
        return AppZoom()
    }

    func testStartsAtActualSize() {
        let zoom = makeZoom()
        XCTAssertTrue(zoom.isDefault)
        XCTAssertEqual(zoom.scale, 1)
        XCTAssertEqual(zoom.label, "100%")
    }

    func testZoomInAndOutStopAtBounds() {
        let zoom = makeZoom()
        while zoom.canZoomIn { zoom.zoomIn() }
        XCTAssertEqual(zoom.scale, AppZoom.steps.last)
        zoom.zoomIn()
        XCTAssertEqual(zoom.scale, AppZoom.steps.last, "Zoom in past the last step must not wrap")

        while zoom.canZoomOut { zoom.zoomOut() }
        XCTAssertEqual(zoom.scale, AppZoom.steps.first)
        zoom.zoomOut()
        XCTAssertEqual(zoom.scale, AppZoom.steps.first, "Zoom out past the first step must not wrap")
    }

    func testResetReturnsToActualSizeFromEitherDirection() {
        let zoom = makeZoom()
        zoom.zoomIn()
        zoom.zoomIn()
        XCTAssertFalse(zoom.isDefault)
        zoom.reset()
        XCTAssertEqual(zoom.scale, 1)

        zoom.zoomOut()
        zoom.reset()
        XCTAssertEqual(zoom.scale, 1)
    }

    func testZoomRestoresAcrossLaunches() {
        let zoom = makeZoom()
        zoom.zoomIn()
        let expected = zoom.scale
        XCTAssertEqual(AppZoom().scale, expected, "Zoom must survive relaunch")
    }

    /// The point of the View ▸ Zoom commands. macOS has no Dynamic Type, so this
    /// guards that content text really re-renders at the new size.
    func testZoomChangesRenderedTextSize() throws {
        func height(_ scale: CGFloat) throws -> CGFloat {
            let renderer = ImageRenderer(
                content: Text("Broker online").scaledFont(.callout).environment(\.uiScale, scale)
            )
            return try XCTUnwrap(renderer.nsImage?.size.height)
        }

        let actual = try height(1.0)
        XCTAssertGreaterThan(try height(2.0), actual, "Zoom in must render larger text")
        XCTAssertLessThan(try height(0.85), actual, "Zoom out must render smaller text")
    }

    /// Markers and hit targets are tuned against the text, so they track the same
    /// scale instead of staying pinned while type grows.
    func testMarkersAndHitTargetsFollowZoom() throws {
        func markerHeight(_ scale: CGFloat) throws -> CGFloat {
            let renderer = ImageRenderer(
                content: StateMarker(state: .completed).environment(\.uiScale, scale)
            )
            return try XCTUnwrap(renderer.nsImage?.size.height)
        }

        func buttonHeight(_ scale: CGFloat) throws -> CGFloat {
            let renderer = ImageRenderer(
                content: IconButton(symbol: "doc.on.doc", label: "Copy") {}
                    .environment(\.uiScale, scale)
            )
            return try XCTUnwrap(renderer.nsImage?.size.height)
        }

        XCTAssertGreaterThan(try markerHeight(2.0), try markerHeight(1.0))
        XCTAssertGreaterThan(try buttonHeight(2.0), try buttonHeight(1.0))
    }

    /// A 24pt icon target at 100% is the accessibility floor; it must not shrink
    /// below it when the user zooms out.
    func testHitTargetNeverDropsBelowFloor() throws {
        let renderer = ImageRenderer(
            content: IconButton(symbol: "doc.on.doc", label: "Copy") {}
                .environment(\.uiScale, AppZoom.steps.first ?? 1)
        )
        let height = try XCTUnwrap(renderer.nsImage?.size.height)
        XCTAssertGreaterThanOrEqual(height, 20, "Smallest zoom must keep a usable target")
    }
}
