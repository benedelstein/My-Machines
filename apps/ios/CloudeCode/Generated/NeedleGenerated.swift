import API
import Entities
import Foundation
import NeedleFoundation

private let needleDependenciesHash: String? = nil

private func parent1(_ component: NeedleFoundation.Scope) -> NeedleFoundation.Scope {
    component.parent
}

#if !NEEDLE_DYNAMIC

private final class ApplicationDependencyProvider: ApplicationDependency {}

private func applicationDependencyFactory(_ component: NeedleFoundation.Scope) -> AnyObject {
    ApplicationDependencyProvider()
}

private final class HomeDependencyProvider: HomeDependency {
    private let applicationComponent: ApplicationComponent

    init(applicationComponent: ApplicationComponent) {
        self.applicationComponent = applicationComponent
    }

    var sessionsAPI: any SessionsAPIProviding {
        applicationComponent.sessionsAPI
    }

    var reposAPI: any ReposAPIProviding {
        applicationComponent.reposAPI
    }

    var modelsAPI: any ModelsAPIProviding {
        applicationComponent.modelsAPI
    }

    @MainActor
    var notificationHandler: NotificationHandler {
        applicationComponent.notificationHandler
    }

    @MainActor
    var sessionSummaryStore: SessionSummaryStore {
        applicationComponent.sessionSummaryStore
    }

    @MainActor
    var sessionClientStateStore: SessionClientStateStore {
        applicationComponent.sessionClientStateStore
    }

    @MainActor
    var newSessionPreferences: NewSessionPreferences {
        applicationComponent.newSessionPreferences
    }

    var cache: Cache {
        applicationComponent.cache
    }

    var userSessionsSocket: UserSessionsSocket {
        applicationComponent.userSessionsSocket
    }
}

private func homeDependencyFactory(_ component: NeedleFoundation.Scope) -> AnyObject {
    HomeDependencyProvider(applicationComponent: parent1(component) as! ApplicationComponent)
}

private final class AgentSessionDependencyProvider: AgentSessionDependency {
    private let applicationComponent: ApplicationComponent
    private let homeComponent: HomeComponent

    init(applicationComponent: ApplicationComponent, homeComponent: HomeComponent) {
        self.applicationComponent = applicationComponent
        self.homeComponent = homeComponent
    }

    func makeSessionSocket(sessionId: String) -> SessionSocket {
        applicationComponent.makeSessionSocket(sessionId: sessionId)
    }

    var authAPI: any AuthAPIProviding {
        applicationComponent.authAPI
    }

    var sessionsAPI: any SessionsAPIProviding {
        applicationComponent.sessionsAPI
    }

    var reposAPI: any ReposAPIProviding {
        applicationComponent.reposAPI
    }

    @MainActor
    var repoEnvironmentsStore: RepoEnvironmentsStore {
        applicationComponent.repoEnvironmentsStore
    }

    var repoEnvironmentsAPI: any RepoEnvironmentsAPIProviding {
        applicationComponent.repoEnvironmentsAPI
    }

    @MainActor
    var modelCatalogStore: ModelCatalogStore {
        homeComponent.modelCatalogStore
    }

    var providerAuthAPI: any ProviderAuthAPIProviding {
        applicationComponent.providerAuthAPI
    }

    var fetchImageAction: any FetchImageAction {
        applicationComponent.fetchImageAction
    }

    var attachmentsAPI: any AttachmentsAPIProviding {
        applicationComponent.attachmentsAPI
    }

    @MainActor
    var sessionMessageStore: SessionMessageStore {
        homeComponent.sessionMessageStore
    }

    @MainActor
    var sessionSummaryStore: SessionSummaryStore {
        applicationComponent.sessionSummaryStore
    }

    @MainActor
    var sessionClientStateStore: SessionClientStateStore {
        applicationComponent.sessionClientStateStore
    }

    @MainActor
    var newSessionPreferences: NewSessionPreferences {
        applicationComponent.newSessionPreferences
    }

}

private func agentSessionDependencyFactory(_ component: NeedleFoundation.Scope) -> AnyObject {
    AgentSessionDependencyProvider(
        applicationComponent: parent1(parent1(component)) as! ApplicationComponent,
        homeComponent: parent1(component) as! HomeComponent
    )
}

private final class EnvironmentEditorDependencyProvider: EnvironmentEditorDependency {
    private let agentSessionComponent: AgentSessionComponent

    init(agentSessionComponent: AgentSessionComponent) {
        self.agentSessionComponent = agentSessionComponent
    }

    var repoEnvironmentsAPI: any RepoEnvironmentsAPIProviding {
        agentSessionComponent.repoEnvironmentsAPI
    }

    @MainActor
    var repoEnvironmentsStore: RepoEnvironmentsStore {
        agentSessionComponent.repoEnvironmentsStore
    }
}

private func environmentEditorDependencyFactory(_ component: NeedleFoundation.Scope) -> AnyObject {
    EnvironmentEditorDependencyProvider(
        agentSessionComponent: parent1(component) as! AgentSessionComponent
    )
}

private final class ProviderConnectionDependencyProvider: ProviderConnectionDependency {
    private let agentSessionComponent: AgentSessionComponent

    init(agentSessionComponent: AgentSessionComponent) {
        self.agentSessionComponent = agentSessionComponent
    }

    var providerAuthAPI: any ProviderAuthAPIProviding {
        agentSessionComponent.providerAuthAPI
    }

    @MainActor
    var modelCatalogStore: ModelCatalogStore {
        agentSessionComponent.modelCatalogStore
    }
}

private func providerConnectionDependencyFactory(_ component: NeedleFoundation.Scope) -> AnyObject {
    ProviderConnectionDependencyProvider(
        agentSessionComponent: parent1(component) as! AgentSessionComponent
    )
}

#endif

private func factoryEmptyDependencyProvider(_ component: NeedleFoundation.Scope) -> AnyObject {
    EmptyDependencyProvider(component: component)
}

private func registerProviderFactory(
    _ componentPath: String,
    _ factory: @escaping (NeedleFoundation.Scope) -> AnyObject
) {
    __DependencyProviderRegistry.instance.registerDependencyProviderFactory(for: componentPath, factory)
}

public func registerProviderFactories() {
    #if !NEEDLE_DYNAMIC
    registerProviderFactory("^->RootComponent", factoryEmptyDependencyProvider)
    registerProviderFactory("^->RootComponent->ApplicationComponent", applicationDependencyFactory)
    registerProviderFactory("^->RootComponent->ApplicationComponent->HomeComponent", homeDependencyFactory)
    registerProviderFactory(
        "^->RootComponent->ApplicationComponent->HomeComponent->AgentSessionComponent",
        agentSessionDependencyFactory
    )
    registerProviderFactory(
        "^->RootComponent->ApplicationComponent->HomeComponent->AgentSessionComponent->EnvironmentEditorComponent",
        environmentEditorDependencyFactory
    )
    registerProviderFactory(
        "^->RootComponent->ApplicationComponent->HomeComponent->AgentSessionComponent->ProviderConnectionComponent",
        providerConnectionDependencyFactory
    )
    #endif
}
