import XCTest
@testable import Inter

final class TaskStateDotTests: XCTestCase {
    /// Every state must read apart from every other at a glance — same rule the
    /// operator gave for the dot itself. Two states sharing both a color and a
    /// fill would be indistinguishable in the list; this fails the moment that
    /// happens again.
    func testEveryStateHasADistinctColorAndFillPair() {
        let states: [TaskState] = [
            .queued, .pending, .running, .needsInput, .answered,
            .blocked, .completed, .failed, .cancelled, .unknown,
        ]

        for i in states.indices {
            for j in states.indices where j > i {
                let a = states[i]
                let b = states[j]
                let sameTint = a.tint == b.tint
                let sameDot = a.dot == b.dot
                XCTAssertFalse(
                    sameTint && sameDot,
                    "\(a) and \(b) share the same (tint, dot) pair"
                )
            }
        }
    }
}
