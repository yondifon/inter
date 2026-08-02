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

    func testSidebarModelDropsTheProviderPrefixOnlyWhenThereIsOne() {
        XCTAssertEqual(task(model: "opencode/big-pickle").shortModel, "big-pickle")
        XCTAssertEqual(task(model: "sonnet").shortModel, "sonnet")
        XCTAssertEqual(task(model: "").shortModel, "")
    }

    func testHeaderPathCollapsesHomeAndLeavesOtherRootsAlone() {
        XCTAssertEqual(task(cwd: "\(NSHomeDirectory())/desgn/inter").displayPath, "~/desgn/inter")
        XCTAssertEqual(task(cwd: "/opt/build/site").displayPath, "/opt/build/site")
    }

    private func task(model: String = "sonnet", cwd: String = "/tmp") -> TaskSnapshot {
        TaskSnapshot(
            id: "1",
            profileId: "worker",
            model: model,
            prompt: "prompt",
            cwd: cwd,
            state: "completed",
            createdAt: "2026-07-29T10:00:00Z",
            updatedAt: "2026-07-29T10:00:00Z",
            output: ""
        )
    }
}
