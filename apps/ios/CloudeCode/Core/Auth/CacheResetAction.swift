import Domain
import Entities
import Foundation

/// Clears cached data and in-memory state owned by the authenticated user.
@MainActor
struct CacheResetAction {
    let userStore: UserStore
    let sessionSummaryStore: SessionSummaryStore
    let sessionMessageStore: SessionMessageStore
    let sessionClientStateStore: SessionClientStateStore
    let modelCatalogStore: ModelCatalogStore
    let repoEnvironmentsStore: RepoEnvironmentsStore

    func callAsFunction() async throws {
        let t0 = Date()
        try await userStore.deleteAll()
        try await sessionSummaryStore.deleteAll()
        try await repoEnvironmentsStore.deleteAll()
        try await sessionMessageStore.deleteAll()
        try await sessionClientStateStore.deleteAll()
        modelCatalogStore.reset()
        Logger.debug("Reset caches in \(Date().timeIntervalSince(t0) * 1000)ms")
    }
}
