import API
import AuthenticationServices
import Combine
import Domain
import Entities
import Foundation
import Observation
import SwiftUI

/// Auth state for the UI and the locally restored session's readiness.
@MainActor @Observable
final class SessionStore {
    enum State: Equatable {
        case loading
        case refreshing(userId: String)
        case signedIn(userId: String)
        case signedOut

        fileprivate var authUserId: String? {
            switch self {
            case .loading, .refreshing, .signedOut:
                nil
            case .signedIn(let userId):
                userId
            }
        }
    }

    private(set) var state: State = .loading {
        didSet {
            authStateSubject.send(state)
        }
    }
    private(set) var user: UserModel?
    private(set) var isSigningIn: Bool = false
    private(set) var signInError: String?
    private let coordinator: TokenCoordinator
    private let userStore: UserStore
    private let signInAPI: any SignInProviding
    private let oauthRedirectURI: String
    private let authStateSubject: CurrentValueSubject<SessionStore.State, Never> =
        CurrentValueSubject<State, Never>(.loading)
    private let didSignOutSubject: PassthroughSubject<Void, Never> = PassthroughSubject<Void, Never>()
    private var initialRefreshTask: Task<Void, Never>?

    var authStatePublisher: AnyPublisher<State, Never> {
        authStateSubject.eraseToAnyPublisher()
    }

    var authUserPublisher: AnyPublisher<String?, Never> {
        authStateSubject
            .map(\.authUserId)
            .removeDuplicates()
            .eraseToAnyPublisher()
    }

    var didSignOutPublisher: AnyPublisher<Void, Never> {
        didSignOutSubject.eraseToAnyPublisher()
    }

    init(
        coordinator: TokenCoordinator,
        userStore: UserStore,
        signInAPI: any SignInProviding,
        oauthRedirectURI: String
    ) {
        self.coordinator = coordinator
        self.userStore = userStore
        self.signInAPI = signInAPI
        self.oauthRedirectURI = oauthRedirectURI
    }

    func start() async {
        switch await coordinator.restore() {
        case .ready(let session):
            Logger.debug("Session restored for user", session.userId)
            state = .signedIn(userId: session.userId)
            user = try? await userStore.get([session.userId], scopes: .all).first
        case .needsRefresh(let session):
            Logger.debug("Session restored pending refresh for user", session.userId)
            state = .refreshing(userId: session.userId)
            startInitialRefresh()
            user = try? await userStore.get(
                [session.userId],
                scopes: [.memory, .disk]
            ).first
        case .signedOut:
            Logger.debug("No stored session; signed out")
            transitionToSignedOut()
        }

        for await event in coordinator.events {
            switch event {
            case .signedIn(let session):
                Logger.debug("Auth event: signedIn", session.userId)
                state = .signedIn(userId: session.userId)
                user = try? await userStore.get([session.userId], scopes: .all).first
            case .signedOut:
                Logger.debug("Auth event: signedOut")
                transitionToSignedOut()
                didSignOutSubject.send()
            case .refreshed(let session):
                Logger.debug("Auth event: refreshed")
                if case .refreshing = state {
                    Logger.debug("transitioning from refreshing to signedIn")
                    initialRefreshTask = nil
                    state = .signedIn(userId: session.userId)
                    user = try? await userStore.get([session.userId], scopes: .all).first
                }
            }
        }
    }

    func stop() {
        initialRefreshTask?.cancel()
        initialRefreshTask = nil
    }

    func signOut() async {
        guard state != .signedOut else { return }
        await coordinator.signOut()
    }

    private func transitionToSignedOut() {
        initialRefreshTask?.cancel()
        initialRefreshTask = nil
        user = nil
        state = .signedOut
    }

    private func startInitialRefresh() {
        initialRefreshTask?.cancel()
        initialRefreshTask = Task { [coordinator] in
            _ = try? await coordinator.refresh()
        }
    }

    /// GitHub sign-in through the system web-auth sheet.
    ///
    /// The server owns the flow: one presentation covers OAuth and, when the
    /// user has no GitHub App installation, repository setup. The app only
    /// starts an attempt and claims the completed identity. Attempt
    /// credentials stay in this function's memory; nothing is persisted, so a
    /// process termination simply abandons the attempt.
    func signIn(using webSession: some WebAuthenticating) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        do {
            let attempt = try await signInAPI.startSignIn(redirectUri: oauthRedirectURI)
            guard let scheme = URL(string: oauthRedirectURI)?.scheme else {
                preconditionFailure("invalid OAUTH_REDIRECT_URI: \(oauthRedirectURI)")
            }
            let callback = try await webSession.authenticate(
                using: attempt.authorizeURL,
                callbackURLScheme: scheme
            )
            guard let completionCode = completionCode(
                from: callback,
                matching: attempt.attemptId
            ) else {
                signInError = "Sign-in failed. Please try again."
                return
            }
            let result = try await signInAPI.completeSignIn(
                attemptId: attempt.attemptId,
                claimToken: attempt.claimToken,
                completionCode: completionCode
            )
            userStore.putSnapshotsToDisk([result.user]) // listener will set the user to state
            await coordinator.adopt(result.session)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            Logger.debug("web-auth session dismissed")
        } catch {
            Logger.error(error.localizedDescription)
            signInError = "Sign-in failed. Please try again."
        }
    }

    private func completionCode(from callback: URL, matching attemptId: String) -> String? {
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        guard query?.first(where: { $0.name == "attemptId" })?.value == attemptId else {
            Logger.error("sign-in callback did not match the started attempt")
            return nil
        }
        if let callbackError = query?.first(where: { $0.name == "error" })?.value {
            Logger.error("sign-in callback reported \(callbackError)")
            return nil
        }
        guard let code = query?.first(where: { $0.name == "completionCode" })?.value,
              !code.isEmpty else {
            Logger.error("sign-in callback did not include completion proof")
            return nil
        }
        return code
    }
}
