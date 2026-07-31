@testable import CloudeCode
import Foundation
import Testing

@Suite("Task retrying")
struct TaskRetryingTests {
    @Test func stopsAfterMaximumAttempts() async {
        let attempts = RetryAttemptCounter()
        let task: Task<Int, any Error> = .retrying(maxAttempts: 3) {
            await attempts.record()
            throw RetryTestError.failed
        }

        do {
            _ = try await task.value
            Issue.record("Expected retry failure")
        } catch {
            #expect(error is RetryTestError)
        }
        #expect(await attempts.count == 3)
    }

    @Test func predicateCanRejectRetry() async {
        let attempts = RetryAttemptCounter()
        let task: Task<Int, any Error> = .retrying(
            maxAttempts: 3,
            shouldRetry: { _ in false },
            operation: {
                await attempts.record()
                throw RetryTestError.failed
            }
        )

        do {
            _ = try await task.value
            Issue.record("Expected retry failure")
        } catch {
            #expect(error is RetryTestError)
        }
        #expect(await attempts.count == 1)
    }

    @Test func exponentialBackoffDoublesAndCaps() {
        let strategy = RetryBackoffStrategy.exponential(
            initial: .seconds(1),
            maximum: .seconds(5)
        )

        #expect(strategy.delay(afterFailedAttempt: 1) == .seconds(1))
        #expect(strategy.delay(afterFailedAttempt: 2) == .seconds(2))
        #expect(strategy.delay(afterFailedAttempt: 3) == .seconds(4))
        #expect(strategy.delay(afterFailedAttempt: 4) == .seconds(5))
    }

    @Test func linearBackoffIncrementsAndCaps() {
        let strategy = RetryBackoffStrategy.linear(
            initial: .seconds(1),
            increment: .seconds(2),
            maximum: .seconds(5)
        )

        #expect(strategy.delay(afterFailedAttempt: 1) == .seconds(1))
        #expect(strategy.delay(afterFailedAttempt: 2) == .seconds(3))
        #expect(strategy.delay(afterFailedAttempt: 3) == .seconds(5))
        #expect(strategy.delay(afterFailedAttempt: 4) == .seconds(5))
    }
}

private actor RetryAttemptCounter {
    private(set) var count: Int = 0

    func record() {
        count += 1
    }
}

private enum RetryTestError: Error {
    case failed
}
