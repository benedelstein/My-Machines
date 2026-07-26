import API
import Entities

struct DeleteSessionAction {
    let sessionsAPI: any SessionsAPIProviding
    let sessionSummaryStore: SessionSummaryStore
    let sessionClientStateStore: SessionClientStateStore

    @MainActor
    func callAsFunction(_ session: SessionSummaryModel) async throws {
        let snapshot = session.snapshot
        sessionSummaryStore.delete([session.id])

        do {
            try await sessionsAPI.delete(sessionId: session.id)
            sessionClientStateStore.delete([session.id])
        } catch {
            sessionSummaryStore.putSnapshotsToDisk([snapshot])
            throw error
        }
    }
}
