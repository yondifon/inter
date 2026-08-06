import XCTest
@testable import Inter

final class BlockedTaskCopyTests: XCTestCase {
    private func completion(
        code: String,
        reason: String? = nil,
        suggestedScope: TaskScope? = nil
    ) -> TaskCompletion {
        TaskCompletion(blocked: true, code: code, reason: reason, suggestedScope: suggestedScope)
    }

    // MARK: - permission_denied

    func testPermissionDeniedWithSuggestedScopeNamesTheDeniedPath() {
        let current = TaskScope(read: ["**"], write: ["src/**"])
        let suggested = TaskScope(read: ["**"], write: ["src/**", "docs/**"])
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "permission_denied", suggestedScope: suggested),
            currentScope: current
        )
        XCTAssertTrue(explanation.headline.contains("docs/**"))
        XCTAssertEqual(explanation.deniedPaths, ["docs/**"])
        XCTAssertEqual(explanation.suggestedScope, suggested)
        XCTAssertFalse(explanation.headline.contains("permission_denied"))
    }

    func testPermissionDeniedWithoutSuggestedScopeFallsBackToGenericLine() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "permission_denied"),
            currentScope: nil
        )
        XCTAssertNil(explanation.suggestedScope)
        XCTAssertTrue(explanation.deniedPaths.isEmpty)
        XCTAssertFalse(explanation.headline.isEmpty)
    }

    // MARK: - needs_authority

    func testNeedsAuthoritySurfacesTheWorkersOwnReason() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "needs_authority", reason: "needs the production DB password"),
            currentScope: nil
        )
        XCTAssertEqual(explanation.detail, "needs the production DB password")
        XCTAssertNil(explanation.suggestedScope)
        XCTAssertFalse(explanation.headline.contains("needs_authority"))
    }

    // MARK: - unverified

    func testUnverifiedNeverShowsTheRawInternalReasonString() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "unverified", reason: "worker exited without an Inter completion marker"),
            currentScope: nil
        )
        XCTAssertNil(explanation.detail)
        XCTAssertFalse(explanation.headline.contains("marker"))
        XCTAssertFalse(explanation.headline.lowercased().contains("unverified"))
    }

    // MARK: - worker_error and other codes

    func testWorkerErrorShowsThePlainHeadlineAndKeepsTheReasonAsDetail() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(
                code: "worker_error",
                reason: "Broker restarted; worker pid 123 could not be identified"
            ),
            currentScope: nil
        )
        XCTAssertFalse(explanation.headline.lowercased().contains("worker_error"))
        XCTAssertEqual(explanation.detail, "Broker restarted; worker pid 123 could not be identified")
    }

    func testUnknownCodeFallsBackToTheGenericInterruptionLine() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "some_future_code", reason: "detail from a newer broker"),
            currentScope: nil
        )
        XCTAssertFalse(explanation.headline.contains("some_future_code"))
        XCTAssertEqual(explanation.detail, "detail from a newer broker")
    }

    // MARK: - Missing completion

    func testMissingCompletionStillProducesAnExplanation() {
        let explanation = BlockedTaskCopy.explain(completion: nil, currentScope: nil)
        XCTAssertFalse(explanation.headline.isEmpty)
        XCTAssertNil(explanation.suggestedScope)
    }

    // MARK: - Which actions a blocked cause offers

    /// The "Continue with wider access" action is the view's sole gate on
    /// `explanation.suggestedScope` — only a scope denial with a computed fix
    /// carries one.
    func testWideningScopeIsOfferedOnlyWhenASuggestedScopeExists() {
        let withScope = BlockedTaskCopy.explain(
            completion: completion(code: "permission_denied", suggestedScope: TaskScope(read: [], write: ["docs/**"])),
            currentScope: TaskScope(read: [], write: [])
        )
        XCTAssertNotNil(withScope.suggestedScope)

        let deniedButNoFix = BlockedTaskCopy.explain(
            completion: completion(code: "permission_denied"),
            currentScope: nil
        )
        XCTAssertNil(deniedButNoFix.suggestedScope)

        let needsAuthority = BlockedTaskCopy.explain(
            completion: completion(code: "needs_authority"),
            currentScope: nil
        )
        XCTAssertNil(needsAuthority.suggestedScope)

        let unverified = BlockedTaskCopy.explain(
            completion: completion(code: "unverified"),
            currentScope: nil
        )
        XCTAssertNil(unverified.suggestedScope)
    }
}
