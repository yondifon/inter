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

    func testNeedsAuthoritySurfacesTheWorkersOwnReasonAsRawReason() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "needs_authority", reason: "needs the production DB password"),
            currentScope: nil
        )
        XCTAssertEqual(explanation.rawReason, "needs the production DB password")
        XCTAssertNil(explanation.suggestedScope)
        XCTAssertFalse(explanation.headline.contains("needs_authority"))
    }

    // MARK: - unverified

    func testUnverifiedNeverShowsTheRawInternalReasonString() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "unverified", reason: "worker exited without an Inter completion marker"),
            currentScope: nil
        )
        XCTAssertNil(explanation.rawReason)
        XCTAssertFalse(explanation.headline.contains("marker"))
        XCTAssertFalse(explanation.headline.lowercased().contains("unverified"))
    }

    // MARK: - worker_error and other codes

    func testWorkerErrorBrokerRestartGetsAPlainInterruptedHeadlineNamingInter() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(
                code: "worker_error",
                reason: "Broker restarted; worker pid 64508 outlived it"
            ),
            currentScope: nil
        )
        XCTAssertFalse(explanation.headline.lowercased().contains("worker_error"))
        XCTAssertFalse(explanation.headline.lowercased().contains("pid"))
        XCTAssertFalse(explanation.headline.lowercased().contains("outlived"))
        XCTAssertTrue(explanation.headline.lowercased().contains("interrupted"))
        // "interrupted" itself contains "inter", so this checks the distinct phrase
        // "Inter restarted" rather than that coincidental substring.
        XCTAssertTrue(explanation.headline.lowercased().contains("inter restarted"))
        XCTAssertEqual(explanation.rawReason, "Broker restarted; worker pid 64508 outlived it")
    }

    func testWorkerErrorWithoutABrokerRestartFallsBackToTheGenericHeadlineAndKeepsRawReason() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "worker_error", reason: "sandbox refused a write it needed"),
            currentScope: nil
        )
        XCTAssertFalse(explanation.headline.lowercased().contains("worker_error"))
        XCTAssertFalse(explanation.headline.lowercased().contains("broker"))
        XCTAssertEqual(explanation.rawReason, "sandbox refused a write it needed")
    }

    func testUnknownCodeFallsBackToTheGenericInterruptionLineAndKeepsRawReason() {
        let explanation = BlockedTaskCopy.explain(
            completion: completion(code: "some_future_code", reason: "detail from a newer broker version"),
            currentScope: nil
        )
        XCTAssertFalse(explanation.headline.contains("some_future_code"))
        XCTAssertEqual(explanation.rawReason, "detail from a newer broker version")
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
