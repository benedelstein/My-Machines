import CoreAPI
import Foundation

/// A short-lived WebSocket upgrade token and its expiry.
public struct WebSocketToken: Sendable {
    public let token: String
    public let expiresAt: ISODateTimeString

    public init(token: String, expiresAt: ISODateTimeString) {
        self.token = token
        self.expiresAt = expiresAt
    }

    /// Whether the token is expired or expires within `margin` seconds.
    /// Unparseable expiries count as expired so a fresh token is fetched.
    public func isExpiredOrExpiring(margin: TimeInterval = 30, now: Date = Date()) -> Bool {
        guard let expiry = ISO8601.date(from: expiresAt) else {
            return true
        }
        return now.addingTimeInterval(margin) >= expiry
    }
}

/// Caches a WebSocket token across reconnect attempts and refetches when it
/// is expired or about to expire. Tokens only matter at upgrade time, so this
/// is consulted once per connection attempt.
public actor WebSocketTokenCache {
    private let fetch: @Sendable () async throws -> WebSocketToken
    private var cached: WebSocketToken?
    private var generation: Int = 0

    public init(fetch: @escaping @Sendable () async throws -> WebSocketToken) {
        self.fetch = fetch
    }

    public func token() async throws -> WebSocketToken {
        if let cached, !cached.isExpiredOrExpiring() {
            return cached
        }
        let fetchGeneration = generation
        let fresh = try await fetch()
        if generation == fetchGeneration {
            cached = fresh
        }
        return fresh
    }

    /// Clears the cached upgrade token when the authenticated user changes.
    public func reset() {
        generation += 1
        cached = nil
    }
}
