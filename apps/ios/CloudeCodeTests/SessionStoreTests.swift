import API
@testable import CloudeCode
import Combine
import Domain
import Entities
import Foundation
import Testing

@Suite("Session store sign-out")
@MainActor
struct SessionStoreTests {
    @Test func explicitSignOutClearsAndRevokesSession() async throws {
        let recorder = SignOutEventRecorder()
        let authAPI = TestAuthAPI(session: Self.session, recorder: recorder)
        let coordinator = TokenCoordinator(
            persistence: TestSessionPersistence(session: Self.session),
            refresher: authAPI,
            revoker: authAPI
        )
        let store = SessionStore(
            coordinator: coordinator,
            userStore: UserStore(),
            signInAPI: authAPI,
            oauthRedirectURI: "cloudecode://auth/callback"
        )
        let signOutCounter = SignOutCounter()
        let cancellable = store.didSignOutPublisher.sink {
            MainActor.assumeIsolated { signOutCounter.count += 1 }
        }
        defer { cancellable.cancel() }
        let startTask = Task { await store.start() }
        defer { startTask.cancel() }
        try await waitUntil { store.state == .signedIn(userId: "user-1") }

        await store.signOut()
        try await waitUntil { store.state == .signedOut }
        #expect(await recorder.events == [.revoke])
        #expect(signOutCounter.count == 1)
    }

    @Test func rejectedRefreshAlsoResetsUserState() async throws {
        let recorder = SignOutEventRecorder()
        let authAPI = TestAuthAPI(
            session: Self.session,
            recorder: recorder,
            rejectsRefresh: true
        )
        let coordinator = TokenCoordinator(
            persistence: TestSessionPersistence(session: Self.session),
            refresher: authAPI,
            revoker: authAPI
        )
        let store = SessionStore(
            coordinator: coordinator,
            userStore: UserStore(),
            signInAPI: authAPI,
            oauthRedirectURI: "cloudecode://auth/callback"
        )
        let signOutCounter = SignOutCounter()
        let cancellable = store.didSignOutPublisher.sink {
            MainActor.assumeIsolated { signOutCounter.count += 1 }
        }
        defer { cancellable.cancel() }
        let startTask = Task { await store.start() }
        defer { startTask.cancel() }
        try await waitUntil { store.state == .signedIn(userId: "user-1") }

        _ = try? await coordinator.refresh()
        try await waitUntil { store.state == .signedOut }
        #expect(await recorder.events.isEmpty)
        #expect(await authAPI.refreshCount == 1)
        #expect(signOutCounter.count == 1)
    }

    @Test func ordinarySignedOutLaunchDoesNotPublishSignOut() async throws {
        let recorder = SignOutEventRecorder()
        let authAPI = TestAuthAPI(session: Self.session, recorder: recorder)
        let coordinator = TokenCoordinator(
            persistence: TestSessionPersistence(session: nil),
            refresher: authAPI,
            revoker: authAPI
        )
        let store = SessionStore(
            coordinator: coordinator,
            userStore: UserStore(),
            signInAPI: authAPI,
            oauthRedirectURI: "cloudecode://auth/callback"
        )
        let signOutCounter = SignOutCounter()
        let cancellable = store.didSignOutPublisher.sink {
            MainActor.assumeIsolated { signOutCounter.count += 1 }
        }
        defer { cancellable.cancel() }
        let startTask = Task { await store.start() }
        defer { startTask.cancel() }

        try await waitUntil { store.state == .signedOut }

        #expect(signOutCounter.count == .zero)
    }

    @Test func staleStoredSessionShowsRefreshingBeforeRefreshCompletes() async throws {
        let gate = RefreshGate()
        let recorder = SignOutEventRecorder()
        let authAPI = TestAuthAPI(
            session: Self.session,
            recorder: recorder,
            refreshGate: gate
        )
        let coordinator = TokenCoordinator(
            persistence: TestSessionPersistence(session: Self.staleSession),
            refresher: authAPI,
            revoker: authAPI
        )
        let store = SessionStore(
            coordinator: coordinator,
            userStore: UserStore(),
            signInAPI: authAPI,
            oauthRedirectURI: "cloudecode://auth/callback"
        )
        let startTask = Task { await store.start() }
        defer { startTask.cancel() }

        try await waitUntil {
            guard store.state == .refreshing(userId: "user-1") else { return false }
            return await gate.isWaiting
        }

        await gate.open()
        try await waitUntil { store.state == .signedIn(userId: "user-1") }
    }

    @Test func transientStartupRefreshRetriesWhileShowingRefreshingState() async throws {
        let gate = RefreshGate()
        let recorder = SignOutEventRecorder()
        let authAPI = TestAuthAPI(
            session: Self.session,
            recorder: recorder,
            refreshGate: gate,
            transientFailuresRemaining: 1
        )
        let coordinator = TokenCoordinator(
            persistence: TestSessionPersistence(session: Self.staleSession),
            refresher: authAPI,
            revoker: authAPI,
            refreshRetryBackoff: .constant(.milliseconds(10))
        )
        let store = SessionStore(
            coordinator: coordinator,
            userStore: UserStore(),
            signInAPI: authAPI,
            oauthRedirectURI: "cloudecode://auth/callback"
        )
        let startTask = Task { await store.start() }
        defer { startTask.cancel() }

        try await waitUntil {
            guard store.state == .refreshing(userId: "user-1") else { return false }
            return await gate.isWaiting
        }
        await gate.open()
        try await waitUntil { store.state == .signedIn(userId: "user-1") }

        #expect(await authAPI.refreshCount == 2)
    }

    private static let session: Session = Session(
        accessToken: "access-token",
        accessTokenExpiresAt: Date.now.addingTimeInterval(3_600),
        refreshToken: "refresh-token",
        refreshTokenExpiresAt: Date.now.addingTimeInterval(86_400),
        userId: "user-1"
    )

    private static let staleSession: Domain.Session = Session(
        accessToken: "stale-access-token",
        accessTokenExpiresAt: Date.now.addingTimeInterval(-60),
        refreshToken: "refresh-token",
        refreshTokenExpiresAt: Date.now.addingTimeInterval(86_400),
        userId: "user-1"
    )

    private func waitUntil(
        _ condition: @MainActor () async -> Bool
    ) async throws {
        for _ in 0..<100 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw SessionStoreTestError.timedOut
    }
}

@MainActor
private final class SignOutCounter {
    var count: Int = 0
}

private final class TestSessionPersistence: SessionPersisting, @unchecked Sendable {
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

private actor TestAuthAPI: SignInProviding, SessionRefreshing, SessionRevoking {
    private let session: Session
    private let recorder: SignOutEventRecorder
    private let rejectsRefresh: Bool
    private let refreshGate: RefreshGate?
    private var transientFailuresRemaining: Int
    private(set) var refreshCount: Int = 0

    init(
        session: Session,
        recorder: SignOutEventRecorder,
        rejectsRefresh: Bool = false,
        refreshGate: RefreshGate? = nil,
        transientFailuresRemaining: Int = 0
    ) {
        self.session = session
        self.recorder = recorder
        self.rejectsRefresh = rejectsRefresh
        self.refreshGate = refreshGate
        self.transientFailuresRemaining = transientFailuresRemaining
    }

    func startSignIn(redirectUri: String) async throws -> GitHubSignInAttempt {
        throw SessionStoreTestError.unexpectedAPICall
    }

    func completeSignIn(
        attemptId: String,
        claimToken: String,
        completionCode: String
    ) async throws -> SignInResult {
        throw SessionStoreTestError.unexpectedAPICall
    }

    func refresh(refreshToken: String) async throws -> Session {
        refreshCount += 1
        if transientFailuresRemaining > 0 {
            transientFailuresRemaining -= 1
            throw URLError(.networkConnectionLost)
        }
        if rejectsRefresh {
            throw APIError.unauthenticated
        }
        await refreshGate?.wait()
        return session
    }

    func logout(refreshToken: String) async throws {
        await recorder.record(.revoke)
    }
}

private actor RefreshGate {
    private(set) var isWaiting: Bool = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        isWaiting = true
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func open() {
        continuation?.resume()
        continuation = nil
        isWaiting = false
    }
}

private actor SignOutEventRecorder {
    enum Event: Equatable {
        case revoke
    }

    private(set) var events: [Event] = []

    func record(_ event: Event) {
        events.append(event)
    }
}

private enum SessionStoreTestError: Error {
    case timedOut
    case unexpectedAPICall
}
