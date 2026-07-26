import API
import Combine
import Entities
import NeedleFoundation
import SwiftUI

protocol HomeDependency: Dependency {
    var sessionsAPI: any SessionsAPIProviding { get }
    var reposAPI: any ReposAPIProviding { get }
    var modelsAPI: any ModelsAPIProviding { get }
    @MainActor
    var notificationHandler: NotificationHandler { get }
    @MainActor
    var sessionSummaryStore: SessionSummaryStore { get }
    @MainActor
    var sessionClientStateStore: SessionClientStateStore { get }
    @MainActor
    var newSessionPreferences: NewSessionPreferences { get }
    var cache: Cache { get }
    var userSessionsSocket: UserSessionsSocket { get }
}

final class HomeComponent: Component<HomeDependency> {
    @MainActor
    var archiveSessionAction: ArchiveSessionAction {
        shared {
            ArchiveSessionAction(
                sessionsAPI: dependency.sessionsAPI,
                sessionSummaryStore: dependency.sessionSummaryStore
            )
        }
    }

    @MainActor
    var deleteSessionAction: DeleteSessionAction {
        shared {
            DeleteSessionAction(
                sessionsAPI: dependency.sessionsAPI,
                sessionSummaryStore: dependency.sessionSummaryStore,
                sessionClientStateStore: dependency.sessionClientStateStore
            )
        }
    }

    @MainActor
    var viewModel: HomeViewModel {
        shared {
            HomeViewModel(
                sessionsAPI: dependency.sessionsAPI,
                sessionSummaryStore: dependency.sessionSummaryStore,
                userSessionsSocket: dependency.userSessionsSocket,
                archiveSessionAction: archiveSessionAction,
                deleteSessionAction: deleteSessionAction
            )
        }
    }

    /// Bridges "a draft created its session" from agent session view models to the
    /// router without threading closures through the view hierarchy.
    @MainActor
    var sessionCreatedSubject: PassthroughSubject<String, Never> {
        shared {
            PassthroughSubject<String, Never>()
        }
    }

    @MainActor
    var router: HomeRouter {
        shared {
            HomeRouter(
                notificationHandler: dependency.notificationHandler,
                sessionSummaryStore: dependency.sessionSummaryStore,
                sessionCreated: sessionCreatedSubject.eraseToAnyPublisher()
            )
        }
    }

    @MainActor
    var sessionMessageStore: SessionMessageStore {
        shared {
            SessionMessageStore(cache: dependency.cache)
        }
    }

    @MainActor
    var sessionClientStateStore: SessionClientStateStore {
        dependency.sessionClientStateStore
    }

    /// Shared across all agent sessions so the model catalog is fetched once
    /// per app session instead of on every session open.
    @MainActor
    var modelCatalogStore: ModelCatalogStore {
        shared {
            ModelCatalogStore(modelsAPI: dependency.modelsAPI)
        }
    }

    @MainActor
    func makeAgentSessionComponent(session: SessionSummaryModel) -> AgentSessionComponent {
        AgentSessionComponent(
            parent: self,
            session: session,
            sessionCreatedSubject: sessionCreatedSubject
        )
    }

    @MainActor
    func makeNewAgentSessionComponent() -> AgentSessionComponent {
        AgentSessionComponent(
            parent: self,
            session: nil,
            sessionCreatedSubject: sessionCreatedSubject
        )
    }
}

@MainActor
struct HomeBuilder {
    let component: HomeComponent

    func build() -> some View {
        HomeView(
            viewModel: component.viewModel,
            router: component.router,
            sessionBuilder: AgentSessionBuilder { [component] session in
                if let session {
                    component.makeAgentSessionComponent(session: session)
                } else {
                    component.makeNewAgentSessionComponent()
                }
            }
        )
    }
}
