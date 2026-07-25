import API
import Domain
import Entities
import Foundation
import NeedleFoundation

protocol ApplicationDependency: Dependency {}

final class ApplicationComponent: Component<ApplicationDependency> {
    @MainActor var hapticFeedbackPlayer: any HapticFeedbackPlaying {
        shared {
            SystemHapticFeedbackPlayer()
        }
    }

    private var apiBaseURL: URL {
        // Injected per scheme via Config/*.xcconfig -> Info.plist.
        guard let string = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
              let url = URL(string: string) else {
            preconditionFailure("missing or invalid API_BASE_URL in Info.plist")
        }
        return url
    }

    private var appGroupIdentifier: String {
        // Injected per scheme via Config/*.xcconfig -> Info.plist.
        guard let identifier = Bundle.main.object(forInfoDictionaryKey: "APP_GROUP_IDENTIFIER") as? String,
              !identifier.isEmpty else {
            preconditionFailure("missing APP_GROUP_IDENTIFIER in Info.plist")
        }
        return identifier
    }

    private var bundleIdentifier: String {
        guard let identifier = Bundle.main.bundleIdentifier, !identifier.isEmpty else {
            preconditionFailure("missing bundle identifier")
        }
        return identifier
    }

    var apiClient: APIClient {
        shared {
            APIClient(baseURL: apiBaseURL) // pure transport
        }
    }

    var unauthenticatedAuthAPI: any UnauthenticatedAuthAPIProviding {
        shared {
            UnauthenticatedAuthAPI(client: apiClient)
        }
    }

    var tokenCoordinator: TokenCoordinator {
        shared {
            TokenCoordinator(
                persistence: KeychainSessionPersistence(
                    bundleIdentifier: bundleIdentifier,
                    legacyAppGroup: appGroupIdentifier
                ),
                refresher: unauthenticatedAuthAPI,
                revoker: unauthenticatedAuthAPI
            )
        }
    }

    var authAPI: any AuthAPIProviding {
        shared {
            AuthAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var notificationsAPI: any NotificationsAPIProviding {
        shared {
            NotificationsAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var attachmentsAPI: any AttachmentsAPIProviding {
        shared {
            AttachmentsAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    @MainActor var notificationHandler: NotificationHandler {
        shared {
            NotificationHandler()
        }
    }

    var sessionsAPI: any SessionsAPIProviding {
        shared {
            SessionsAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var reposAPI: any ReposAPIProviding {
        shared {
            ReposAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var modelsAPI: any ModelsAPIProviding {
        shared {
            ModelsAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var providerAuthAPI: any ProviderAuthAPIProviding {
        shared {
            ProviderAuthAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    var repoEnvironmentsAPI: any RepoEnvironmentsAPIProviding {
        shared {
            RepoEnvironmentsAPI(client: apiClient, tokenProvider: tokenCoordinator)
        }
    }

    @MainActor var repoEnvironmentsStore: RepoEnvironmentsStore {
        shared {
            RepoEnvironmentsStore(cache: cache) { [repoEnvironmentsAPI] repoId in
                try await repoEnvironmentsAPI.listEnvironments(repoId: repoId)
            }
        }
    }

    var fetchImageAction: any FetchImageAction {
        AuthenticatedFetchImageAction(apiBaseURL: apiBaseURL) { [tokenCoordinator] in
            try await tokenCoordinator.bearerHeaders()
        }
    }

    @MainActor var sessionStore: SessionStore {
        shared {
            SessionStore(
                coordinator: tokenCoordinator,
                userStore: userStore,
                signInAPI: unauthenticatedAuthAPI,
                oauthRedirectURI: Constants.oauthRedirectURI
            )
        }
    }

    @MainActor var cacheResetWorker: CacheResetWorker {
        shared {
            CacheResetWorker(
                cacheResetAction: cacheResetAction,
                didSignOutPublisher: sessionStore.didSignOutPublisher
            )
        }
    }

    @MainActor var cacheResetAction: CacheResetAction {
        shared {
            CacheResetAction(
                userStore: userStore,
                sessionSummaryStore: sessionSummaryStore,
                sessionMessageStore: homeComponent.sessionMessageStore,
                modelCatalogStore: homeComponent.modelCatalogStore,
                repoEnvironmentsStore: repoEnvironmentsStore
            )
        }
    }

    @MainActor var notificationRegistrationService: NotificationRegistrationService {
        shared {
            NotificationRegistrationService(
                notificationsAPI: notificationsAPI,
                authUserPublisher: sessionStore.authUserPublisher,
                notificationHandler: notificationHandler
            )
        }
    }

    /// Sidebar session-list updates stream. Shared: one socket per app.
    var userSessionsSocket: UserSessionsSocket {
        shared {
            UserSessionsSocket(
                baseURL: apiBaseURL,
                tokenCache: WebSocketTokenCache { [sessionsAPI] in
                    try await sessionsAPI.userSessionsWebSocketToken()
                }
            )
        }
    }

    /// Per-session chat stream. Not shared: each open session owns a socket.
    func makeSessionSocket(sessionId: String) -> SessionSocket {
        SessionSocket(
            baseURL: apiBaseURL,
            sessionId: sessionId,
            tokenCache: WebSocketTokenCache { [sessionsAPI] in
                try await sessionsAPI.sessionWebSocketToken(sessionId: sessionId)
            }
        )
    }

    var cache: Cache {
        shared {
            do {
                return try Cache(container: ModelContainerFactory().make())
            } catch {
                preconditionFailure("failed to create cache container: \(error)")
            }
        }
    }

    @MainActor var userStore: UserStore {
        shared {
            UserStore(cache: cache) { [authAPI] _ in
                // /auth/me is the only user source today; ids are ignored.
                try await [authAPI.me()]
            }
        }
    }

    @MainActor var sessionSummaryStore: SessionSummaryStore {
        shared {
            // todo add a summary get endpoint rn we just have a get that returns data from the do.
            SessionSummaryStore(cache: cache)
        }
    }

    @MainActor var newSessionPreferences: NewSessionPreferences {
        shared {
            NewSessionPreferences(userDefaults: userDefaults)
        }
    }

    var userDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }

    @MainActor
    var homeComponent: HomeComponent {
        shared {
            HomeComponent(parent: self)
        }
    }
}
