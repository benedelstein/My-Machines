import Foundation
import os

enum TranscriptPerformanceSignpost {
    struct Interval {
        fileprivate let id: OSSignpostID
    }

    private static let log: OSLog = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "llc.bze.CloudeCode",
        category: "TranscriptPerformance"
    )

    static func begin(_ name: StaticString) -> Interval {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: name, signpostID: id)
        return Interval(id: id)
    }

    static func end(_ name: StaticString, _ interval: Interval) {
        os_signpost(.end, log: log, name: name, signpostID: interval.id)
    }

    static func measure<T>(_ name: StaticString, _ body: () throws -> T) rethrows -> T {
        let interval = begin(name)
        defer { end(name, interval) }
        return try body()
    }
}
