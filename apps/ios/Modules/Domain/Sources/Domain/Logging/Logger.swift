import Foundation

public enum LogLevel: String, CaseIterable, Sendable {
    case debug = "DEBUG"
    case info = "INFO"
    case warning = "WARNING"
    case error = "ERROR"

    public var severity: Int {
        switch self {
        case .debug:
            0
        case .info:
            1
        case .warning:
            2
        case .error:
            3
        }
    }
}

public protocol LogDestination: Sendable {
    func log(_ entry: LogEntry)
}

public struct LogEntry: Sendable {
    public let message: String
    public let level: LogLevel
    public let file: String
    public let function: String
    public let line: Int
    public let terminator: String
}

private struct LogContext {
    let level: LogLevel
    let separator: String
    let terminator: String
    let file: String
    let function: String
    let line: Int
}

public struct ConsoleLogDestination: LogDestination {
    public init() {}

    public func log(_ entry: LogEntry) {
        let fileName = URL(fileURLWithPath: entry.file).deletingPathExtension().lastPathComponent
        Swift.print(
            "[\(entry.level.rawValue)] \(fileName):\(entry.line) - \(entry.message)",
            terminator: entry.terminator
        )
    }
}

/// Process-wide logger. Lives in Domain so every module upstream of the app
/// target (API, Entities, …) can log through the same destinations.
/// All mutable state is lock-guarded; safe to call from any isolation.
public final class Logger: @unchecked Sendable {
    public static let shared: Logger = Logger()

    private let lock: NSLock = NSLock()
    private var _minimumLogLevel: LogLevel = .info
    private var destinations: [any LogDestination] = []

    public var minimumLogLevel: LogLevel {
        get { lock.withLock { _minimumLogLevel } }
        set { lock.withLock { _minimumLogLevel = newValue } }
    }

    private init() {
        addDestination(ConsoleLogDestination())
    }

    public func setDestinations(_ destinations: [any LogDestination]) {
        lock.withLock { self.destinations = destinations }
    }

    public func addDestination(_ destination: any LogDestination) {
        lock.withLock { destinations.append(destination) }
    }

    public static func setDestinations(_ destinations: [any LogDestination]) {
        shared.setDestinations(destinations)
    }

    public static func addDestination(_ destination: any LogDestination) {
        shared.addDestination(destination)
    }

    private func log(
        _ items: [Any?],
        context: LogContext
    ) {
        let (level, currentDestinations) = lock.withLock { (_minimumLogLevel, destinations) }
        guard context.level.severity >= level.severity else {
            return
        }

        let message = items
            .map { item in
                guard let item else {
                    return "nil"
                }

                return String(describing: item)
            }
            .joined(separator: context.separator)

        for destination in currentDestinations {
            destination.log(LogEntry(
                message: message,
                level: context.level,
                file: context.file,
                function: context.function,
                line: context.line,
                terminator: context.terminator
            ))
        }
    }

    public static func debug(
        _ items: Any?...,
        separator: String = " ",
        terminator: String = "\n",
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            items,
            context: LogContext(
                level: .debug,
                separator: separator,
                terminator: terminator,
                file: file,
                function: function,
                line: line
            )
        )
    }

    public static func info(
        _ items: Any?...,
        separator: String = " ",
        terminator: String = "\n",
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            items,
            context: LogContext(
                level: .info,
                separator: separator,
                terminator: terminator,
                file: file,
                function: function,
                line: line
            )
        )
    }

    public static func log(
        _ items: Any?...,
        separator: String = " ",
        terminator: String = "\n",
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            items,
            context: LogContext(
                level: .info,
                separator: separator,
                terminator: terminator,
                file: file,
                function: function,
                line: line
            )
        )
    }

    public static func warning(
        _ items: Any?...,
        separator: String = " ",
        terminator: String = "\n",
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            items,
            context: LogContext(
                level: .warning,
                separator: separator,
                terminator: terminator,
                file: file,
                function: function,
                line: line
            )
        )
    }

    public static func error(
        _ items: Any?...,
        separator: String = " ",
        terminator: String = "\n",
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            items,
            context: LogContext(
                level: .error,
                separator: separator,
                terminator: terminator,
                file: file,
                function: function,
                line: line
            )
        )
    }

    public static func error(
        _ error: any Error,
        file: String = #fileID,
        function: String = #function,
        line: Int = #line
    ) {
        shared.log(
            [error.localizedDescription],
            context: LogContext(
                level: .error,
                separator: " ",
                terminator: "\n",
                file: file,
                function: function,
                line: line
            )
        )
    }
}
