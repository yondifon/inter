import XCTest
@testable import Inter

final class ProfileModelTests: XCTestCase {
    func testEmptyProfileUsesProviderDefaultUntilModelIsSpecified() {
        var profile = Profile.empty
        XCTAssertNil(profile.model)
        XCTAssertEqual(profile.resolvedModel, "sonnet")

        profile.provider = .antigravity
        XCTAssertEqual(profile.resolvedModel, "gemini-3.6-flash-medium")

        profile.model = "claude-sonnet-4-6"
        XCTAssertEqual(profile.resolvedModel, "claude-sonnet-4-6")
    }
}
