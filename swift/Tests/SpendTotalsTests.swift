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
}
