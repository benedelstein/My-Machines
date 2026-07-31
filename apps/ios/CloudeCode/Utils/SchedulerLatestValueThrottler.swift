import Combine
import Foundation

@MainActor
protocol LatestValueThrottling<Value>: AnyObject {
    associatedtype Value

    func submit(_ value: Value)
    func flush()
    func cancel()
}

@MainActor
final class SchedulerLatestValueThrottler<Value>: LatestValueThrottling {
    private let interval: DispatchQueue.SchedulerTimeType.Stride
    private let scheduler: DispatchQueue
    private let onValue: @MainActor (Value) -> Void

    private var latestValue: Value?
    private var lastEmitTime: DispatchQueue.SchedulerTimeType?
    private var scheduledToken: Int?
    private var nextToken: Int = 0

    init(
        interval: DispatchQueue.SchedulerTimeType.Stride,
        scheduler: DispatchQueue = .main,
        onValue: @escaping @MainActor (Value) -> Void
    ) {
        self.interval = interval
        self.scheduler = scheduler
        self.onValue = onValue
    }

    func submit(_ value: Value) {
        latestValue = value

        let now = scheduler.now
        // for the first submitted value, emit immediately (leading-edge)
        guard let lastEmitTime else {
            emit(now: now)
            return
        }

        // for subsequent values, emit the throttled trailing-edge
        let nextAllowedTime = lastEmitTime.advanced(by: interval)
        if now >= nextAllowedTime {
            emit(now: now)
            return
        }

        scheduleIfNeeded(at: nextAllowedTime)
    }

    func flush() {
        scheduledToken = nil
        emit(now: scheduler.now)
    }

    func cancel() {
        scheduledToken = nil
        latestValue = nil
    }

    private func scheduleIfNeeded(at date: DispatchQueue.SchedulerTimeType) {
        guard scheduledToken == nil else {
            return
        }

        nextToken += 1
        let token = nextToken
        scheduledToken = token

        scheduler.schedule(after: date) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, scheduledToken == token else {
                    return
                }
                scheduledToken = nil
                emit(now: scheduler.now)
            }
        }
    }

    private func emit(now: DispatchQueue.SchedulerTimeType) {
        guard let value = latestValue else {
            return
        }

        latestValue = nil
        lastEmitTime = now
        onValue(value)
    }
}
