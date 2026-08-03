import XCTest

@testable import Inter

final class MiddleTruncationTests: XCTestCase {
    /// A path that fits the budget is shown whole; truncation must not touch it.
    func testShortStringIsUnchanged() {
        XCTAssertEqual(middleTruncated("~/desgn/inter", maxChars: 28), "~/desgn/inter")
        XCTAssertEqual(middleTruncated("", maxChars: 28), "")
    }

    /// The boundary: a string of exactly the budget fits, one character more does
    /// not, and whatever comes out never exceeds the budget.
    func testLongStringIsMiddleTruncatedToTheBudget() {
        XCTAssertEqual(middleTruncated(String(repeating: "a", count: 28), maxChars: 28), String(repeating: "a", count: 28))
        let truncated = middleTruncated(String(repeating: "a", count: 60), maxChars: 28)
        XCTAssertLessThanOrEqual(truncated.count, 28)
        XCTAssertTrue(truncated.contains("…"))
    }

    /// The two halves that identify a path — the leading `~/` and the folder
    /// name — must survive; only the middle goes.
    func testLeadingAndTrailingSegmentsSurviveTruncation() {
        let truncated = middleTruncated("~/desgn/inter/packages/worker/tooling-scripts", maxChars: 28)
        XCTAssertTrue(truncated.hasPrefix("~/desgn"))
        XCTAssertTrue(truncated.hasSuffix("scripts"))
    }
}
