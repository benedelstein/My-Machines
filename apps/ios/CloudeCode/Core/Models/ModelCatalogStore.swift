import API
import CoreAPI
import Foundation

/// In-memory cache of the model catalog for the app session.
/// `load()` is safe to call on every session open: it no-ops once the catalog
/// is loaded, deduplicates concurrent loads, and retries after a failure.
@MainActor
@Observable
final class ModelCatalogStore {
    private let modelsAPI: any ModelsAPIProviding

    private(set) var catalog: ModelsResponse?
    private(set) var isLoading: Bool = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var loadGeneration: Int = 0

    init(modelsAPI: any ModelsAPIProviding) {
        self.modelsAPI = modelsAPI
    }

    func load() async {
        guard catalog == nil else {
            return
        }
        if let loadTask {
            await loadTask.value
            return
        }

        isLoading = true
        errorMessage = nil
        let generation = loadGeneration
        let task = Task {
            do {
                let response = try await modelsAPI.models()
                guard generation == loadGeneration, !Task.isCancelled else { return }
                catalog = ModelsResponse(providers: Self.sortedProviders(response.providers))
            } catch {
                guard generation == loadGeneration, !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
        loadTask = task
        await task.value
        guard generation == loadGeneration else { return }
        loadTask = nil
        isLoading = false
    }

    /// Clears the user-scoped catalog and cancels an in-flight load.
    func reset() {
        loadGeneration += 1
        loadTask?.cancel()
        loadTask = nil
        catalog = nil
        isLoading = false
        errorMessage = nil
    }

    /// Sorted once at load so views never sort per render: selectable providers
    /// first, original catalog order preserved within each group.
    private static func sortedProviders(_ providers: [ProviderCatalogEntry]) -> [ProviderCatalogEntry] {
        providers.filter(\.isSelectable) + providers.filter { !$0.isSelectable }
    }
}

extension ProviderCatalogEntry {
    /// Models can only be selected from providers that are connected and healthy.
    var isSelectable: Bool {
        connected && !requiresReauth
    }
}
