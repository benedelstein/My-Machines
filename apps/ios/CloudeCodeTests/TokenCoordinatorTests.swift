import API
@testable import CloudeCode
import Domain
import Foundation
import Testing

@Suite("Token coordinator")
struct TokenCoordinatorTests {
    @Test func concurrentRefreshCallsShareOneRotation() async throws {
        let session = Self.session(refreshToken: "refresh-0")
        let authAPI = RotatingAuthAPI()
        let coordinator = TokenCoordinator(
            persistence: TestTokenPersistence(session: session),
            refresher: authAPI,
            revoker: authAPI
        )

        let restored = await coordinator.restore()
        #expect(restored == .ready(session))

        async let first = coordinator.refresh()
        async let second = coordinator.refresh()
        let (firstSession, secondSession) = try await (first, second)

        #expect(await authAPI.refreshCount == 1)
        #expect(firstSession == secondSession)
        #expect(firstSession.refreshToken == "refresh-1")
    }

    private static func session(refreshToken: String) -> Session {
        Session(
            accessToken: "access-\(refreshToken)",
            accessTokenExpiresAt: Date.now.addingTimeInterval(3_600),
            refreshToken: refreshToken,
            refreshTokenExpiresAt: Date.now.addingTimeInterval(86_400),
            userId: "user-1"
        )
    }
}

private final class TestTokenPersistence: SessionPersisting, @unchecked Sendable {
    private var session: Session?

    init(session: Session?) {
        self.session = session
    }

    func load() throws -> Session? {
        session
    }

    func save(_ session: Session) throws {
        self.session = session
    }

    func clear() throws {
        session = nil
    }
}

private actor RotatingAuthAPI: SessionRefreshing, SessionRevoking {
    private(set) var refreshCount: Int = 0

    func refresh(refreshToken: String) async throws -> Session {
        refreshCount += 1
        try await Task.sleep(for: .milliseconds(50))
        return Session(
            accessToken: "access-\(refreshCount)",
            accessTokenExpiresAt: Date.now.addingTimeInterval(3_600),
            refreshToken: "refresh-\(refreshCount)",
            refreshTokenExpiresAt: Date.now.addingTimeInterval(86_400),
            userId: "user-1"
        )
    }

    func logout(refreshToken: String) async throws {}
}
