import API
import CoreAPI
import Foundation
import Observation

/// State and effects for provider connection management in Settings.
@MainActor
@Observable
final class SettingsViewModel {
    enum Provider: String, CaseIterable, Hashable, Identifiable {
        case claude
        case codex

        var id: String { rawValue }

        var providerId: ProviderId {
            switch self {
            case .claude:
                .claudeCode
            case .codex:
                .openaiCodex
            }
        }

        var displayName: String {
            switch self {
            case .claude:
                "Claude"
            case .codex:
                "OpenAI Codex"
            }
        }

        var connectedToastName: String {
            switch self {
            case .claude:
                "Claude"
            case .codex:
                "Codex"
            }
        }
    }

    enum ConnectionState: Equatable {
        case checking
        case connected
        case reconnectRequired
        case notConnected
        case unavailable
        case disconnecting
    }

    struct Notice: Equatable {
        enum Kind: Equatable {
            case disconnected(Provider)
            case error
        }

        let id: UUID = UUID()
        let kind: Kind
        let message: String
    }

    let providerAuthAPI: any ProviderAuthAPIProviding
    let modelCatalogStore: ModelCatalogStore
    @ObservationIgnored private var disconnectTasks: [Provider: Task<Void, Never>] = [:]
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    private(set) var disconnectingProviders: Set<Provider> = []
    private(set) var notice: Notice?

    init(
        providerAuthAPI: any ProviderAuthAPIProviding,
        modelCatalogStore: ModelCatalogStore
    ) {
        self.providerAuthAPI = providerAuthAPI
        self.modelCatalogStore = modelCatalogStore
    }

    func catalogEntry(for provider: Provider) -> ProviderCatalogEntry? {
        modelCatalogStore.catalog?.providers.first { $0.providerId == provider.providerId }
    }

    func connectionState(for provider: Provider) -> ConnectionState {
        if disconnectingProviders.contains(provider) {
            return .disconnecting
        }
        guard let catalog = modelCatalogStore.catalog else {
            return modelCatalogStore.errorMessage == nil ? .checking : .unavailable
        }
        guard let entry = catalog.providers.first(where: { $0.providerId == provider.providerId }) else {
            return .notConnected
        }
        if entry.requiresReauth {
            return .reconnectRequired
        }
        return entry.connected ? .connected : .notConnected
    }

    func load() {
        guard loadTask == nil else { return }
        loadTask = Task { [weak self] in
            guard let self else { return }
            await modelCatalogStore.load()
            loadTask = nil
        }
    }

    func retryLoading() {
        modelCatalogStore.reset()
        load()
    }

    func disconnect(_ provider: Provider) {
        guard disconnectTasks[provider] == nil else { return }
        disconnectingProviders.insert(provider)

        disconnectTasks[provider] = Task { [weak self] in
            guard let self else { return }
            defer {
                disconnectingProviders.remove(provider)
                disconnectTasks[provider] = nil
            }

            do {
                switch provider {
                case .claude:
                    try await providerAuthAPI.disconnectClaude()
                case .codex:
                    try await providerAuthAPI.disconnectOpenAI()
                }
                guard !Task.isCancelled else { return }
                modelCatalogStore.reset()
                await modelCatalogStore.load()
                guard !Task.isCancelled else { return }
                notice = Notice(
                    kind: .disconnected(provider),
                    message: "\(provider.connectedToastName) disconnected"
                )
            } catch is CancellationError {
                return
            } catch {
                notice = Notice(kind: .error, message: error.localizedDescription)
            }
        }
    }

    func unload() {
        disconnectTasks.values.forEach { $0.cancel() }
        disconnectTasks.removeAll()
        disconnectingProviders.removeAll()
        loadTask?.cancel()
        loadTask = nil
    }
}
