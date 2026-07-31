import Domain
import Foundation

@MainActor
@Observable
final class AppLogStore {
    private let limit: Int
    private(set) var entries: [AppLogRecord] = []

    init(limit: Int = 500) {
        self.limit = limit
    }

    func append(_ entry: LogEntry) {
        entries.append(AppLogRecord(entry: entry))

        let overflow = entries.count - limit
        if overflow > 0 {
            entries.removeFirst(overflow)
        }
    }

    var exportText: String {
        entries
            .map(\.exportText)
            .joined(separator: "\n")
    }
}

struct AppLogRecord: Identifiable, Equatable {
    let id: UUID = UUID()
    let timestamp: Date
    let level: LogLevel
    let message: String
    let file: String
    let function: String
    let line: Int

    init(entry: LogEntry) {
        timestamp = Date()
        level = entry.level
        message = entry.message
        file = entry.file
        function = entry.function
        line = entry.line
    }

    var location: String {
        let fileName = URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
        return "\(fileName).\(function):\(line)"
    }

    var displayTime: String {
        timestamp.formatted(.dateTime.hour().minute().second())
    }

    var exportText: String {
        "[\(level.rawValue)] \(displayTime) \(location) - \(message)"
    }
}

final class MemoryLogDestination: LogDestination, @unchecked Sendable {
    private let store: AppLogStore

    init(store: AppLogStore) {
        self.store = store
    }

    func log(_ entry: LogEntry) {
        Task { @MainActor [store] in
            store.append(entry)
        }
    }
}
