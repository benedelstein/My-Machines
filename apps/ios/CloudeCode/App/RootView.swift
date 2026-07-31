import SwiftUI

struct RootView: View {
    private let component: ApplicationComponent
    private let sessionStore: SessionStore
    private let notificationRegistrationService: NotificationRegistrationService
    private let logStore: AppLogStore
    @State private var isSettingsPresented: Bool = false

    init(component: ApplicationComponent, logStore: AppLogStore) {
        self.component = component
        self.logStore = logStore
        sessionStore = component.sessionStore
        notificationRegistrationService = component.notificationRegistrationService
    }

    var body: some View {
        ZStack {
            Group {
                switch sessionStore.state {
                case .loading:
                    Color.clear
                case .refreshing, .signedIn:
                    HomeBuilder(component: component.homeComponent).build()
                case .signedOut:
                    SignedOutView(sessionStore: sessionStore)
                }
            }
            .transition(.opacity.animation(.easeIn(duration: 0.3)))
            .zIndex(1)
        }
        // need to grab the theme from the injected themedRoot via subview
        .background(ThemedView { $0.backgroundColor.ignoresSafeArea() })
        .environment(\.openSettings, OpenSettingsAction {
            isSettingsPresented = true
        })
        .environment(\.notificationRegistrationService, notificationRegistrationService)
        .sheet(isPresented: $isSettingsPresented) {
            SettingsView(
                logStore: logStore,
                sessionStore: sessionStore,
                providerAuthAPI: component.providerAuthAPI,
                modelCatalogStore: component.homeComponent.modelCatalogStore
            )
        }
        .themedRoot()
    }
}
