import XCTest
@testable import Inter

final class SpendTotalsTests: XCTestCase {
    // MARK: - Decoding

    func testDecodesFromStatePollJSON() throws {
        let json = """
        { "costUsd": 1.2437, "tokens": 1234567, "since": "2026-08-05T00:00:00.000Z" }
        """
        let spend = try JSONDecoder().decode(SpendTotals.self, from: Data(json.utf8))
        XCTAssertEqual(spend.costUsd, 1.2437)
        XCTAssertEqual(spend.tokens, 1234567)
        XCTAssertEqual(spend.since, "2026-08-05T00:00:00.000Z")
    }

    // MARK: - Sidebar footer summary

    func testFormatsCostToTwoDecimalsAndTokensCompactly() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 1234567, since: "")
        XCTAssertEqual(spend.summary, "$1.24 · 1.2M")
    }

    func testFreeModelsStillShowTheirTokenCount() {
        // Zero cost with real token usage is the common case, not the broken
        // one: most of a session can run on a free model that reports $0.
        let spend = SpendTotals(costUsd: 0, tokens: 847_000, since: "")
        XCTAssertEqual(spend.summary, "$0.00 · 847k")
    }

    func testHidesEntirelyWhenTheWindowSawNoActivity() {
        let spend = SpendTotals(costUsd: 0, tokens: 0, since: "")
        XCTAssertNil(spend.summary)
    }

    func testShowsUpOnTokensAloneEvenAtZeroCost() {
        let spend = SpendTotals(costUsd: 0, tokens: 42, since: "")
        XCTAssertNotNil(spend.summary)
    }

    // MARK: - Period label

    func testLabelsTheWindowTheBrokerSummedOver() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 1_200_000, since: "", windowMs: 24 * 3_600_000)
        XCTAssertEqual(spend.summary, "$1.24 · last 24h · 1.2M")
    }

    func testLabelsWholeDayWindowsAsDays() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 1_200_000, since: "", windowMs: 7 * 86_400_000)
        XCTAssertEqual(spend.summary, "$1.24 · last 7d · 1.2M")
    }

    func testFallsBackToSinceWhenTheBrokerDidNotSendAWindow() {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let since = formatter.string(from: Date().addingTimeInterval(-24 * 3_600))
        let spend = SpendTotals(costUsd: 1.2437, tokens: 1_200_000, since: since)
        XCTAssertEqual(spend.summary, "$1.24 · last 24h · 1.2M")
    }

    func testOmitsThePeriodWhenNeitherWindowNorSinceIsKnown() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 1_200_000, since: "")
        XCTAssertEqual(spend.summary, "$1.24 · 1.2M")
    }

    // MARK: - Hover detail

    func testDetailExplainsTheFloorMarker() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 847_000, since: "", windowMs: 24 * 3_600_000, unpricedTasks: 2)
        XCTAssertEqual(spend.detail, "$1.24+ · last 24h · 847k · cost unknown for 2 tasks")
    }

    func testDetailExplainsASingleUnpricedTask() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 847_000, since: "", windowMs: 24 * 3_600_000, unpricedTasks: 1)
        XCTAssertEqual(spend.detail, "$1.24+ · last 24h · 847k · cost unknown for 1 task")
    }

    func testDetailIsJustTheSummaryWhenNothingIsUnpriced() {
        let spend = SpendTotals(costUsd: 1.2437, tokens: 847_000, since: "")
        XCTAssertEqual(spend.detail, spend.summary)
    }
}
