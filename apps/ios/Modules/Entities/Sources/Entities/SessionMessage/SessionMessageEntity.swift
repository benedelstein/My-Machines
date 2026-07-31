import Domain
import Foundation
import SwiftData

/// SwiftData persistence row for one cached session transcript message.
@Model
public final class SessionMessageEntity: Entity {
    @Attribute(.unique) public private(set) var id: String
    var role: String
    // Future optimization: this query shape wants a composite (sessionId, createdAt)
    // index, but SwiftData indexes have been crash-prone across schema changes.
    // Add only after profiling shows fetch/sort, not JSON decode, is the bottleneck.
    var sessionId: String
    var createdAt: Date
    var messageData: Data
    var isStreaming: Bool = false

    /// Creates a persistence row from a session message snapshot.
    public init(_ snapshot: SessionMessageData) {
        id = snapshot.id
        role = snapshot.message.role.rawValue
        sessionId = snapshot.sessionId
        createdAt = snapshot.createdAt
        messageData = Self.encode(snapshot.message)
        isStreaming = snapshot.isStreaming
    }

    /// Updates this persistence row from a session message snapshot.
    public func update(_ snapshot: SessionMessageData) {
        role = snapshot.message.role.rawValue
        sessionId = snapshot.sessionId
        createdAt = snapshot.createdAt
        messageData = Self.encode(snapshot.message)
        isStreaming = snapshot.isStreaming
    }

    /// Decodes a persistence row into a cache snapshot.
    public func makeSnapshot() throws -> SessionMessageData {
        SessionMessageData(
            sessionId: sessionId,
            createdAt: createdAt,
            message: try JSONDecoder().decode(Domain.SessionMessage.self, from: messageData),
            isStreaming: isStreaming
        )
    }

    public static func singleItemPredicate(_ id: String) -> Predicate<SessionMessageEntity> {
        #Predicate { $0.id == id }
    }

    public static func multiItemPredicate(_ ids: Set<String>) -> Predicate<SessionMessageEntity> {
        #Predicate { ids.contains($0.id) }
    }

    private static func encode(_ message: Domain.SessionMessage) -> Data {
        do {
            return try JSONEncoder().encode(message)
        } catch {
            preconditionFailure("failed to encode session message cache row: \(error)")
        }
    }
}
