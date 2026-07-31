import Combine
import Domain
import Foundation

/// Resets user-scoped caches whenever authentication resolves to signed out.
@MainActor
final class CacheResetWorker: Worker {
    private let cacheResetAction: CacheResetAction
    private let didSignOutPublisher: AnyPublisher<Void, Never>
    private var cancellables: Set<AnyCancellable> = Set<AnyCancellable>()

    init(
        cacheResetAction: CacheResetAction,
        didSignOutPublisher: AnyPublisher<Void, Never>
    ) {
        self.cacheResetAction = cacheResetAction
        self.didSignOutPublisher = didSignOutPublisher
    }

    override func didStart() {
        didSignOutPublisher
            .sink { [cacheResetAction] in
                Task { @MainActor in
                    Logger.debug("resetting cache due to sign out")
                    do {
                        try await cacheResetAction()
                    } catch {
                        Logger.warning("Failed to reset signed-out cache", error)
                    }
                }
            }
            .store(in: &cancellables)
    }

    override func didStop() {
        cancellables.removeAll()
    }
}
