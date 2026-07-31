import API
import Entities
import Domain
import Foundation

struct HomeSessionGroup: Identifiable, Hashable {
    let repoId: Int
    let repoFullName: String
    var sessions: [SessionSummaryModel]

    var id: Int { repoId }
}

@MainActor
@Observable
final class HomeViewModel {
    private let sessionsAPI: any SessionsAPIProviding
    private let sessionSummaryStore: SessionSummaryStore
    private let userSessionsSocket: UserSessionsSocket
    private let archiveSessionAction: ArchiveSessionAction
    private let deleteSessionAction: DeleteSessionAction
    private var didStart: Bool = false
    private var hasConnected: Bool = false
    private var socketTask: Task<Void, Never>?

    private(set) var isLoading: Bool = false
    private(set) var hasLoaded: Bool = false
    private(set) var errorMessage: String?
    private(set) var nextRepoCursor: String?

    /// Groups are derived from the store's canonical model instances, so
    /// cache loads, server refreshes, and socket updates all flow through
    /// the same objects.
    var groups: [HomeSessionGroup] {
        Self.groups(from: Array(sessionSummaryStore.objectMap.values))
    }

    var isEmpty: Bool {
        groups.allSatisfy { $0.sessions.isEmpty }
    }

    init(
        sessionsAPI: any SessionsAPIProviding,
        sessionSummaryStore: SessionSummaryStore,
        userSessionsSocket: UserSessionsSocket,
        archiveSessionAction: ArchiveSessionAction,
        deleteSessionAction: DeleteSessionAction
    ) {
        self.sessionsAPI = sessionsAPI
        self.sessionSummaryStore = sessionSummaryStore
        self.userSessionsSocket = userSessionsSocket
        self.archiveSessionAction = archiveSessionAction
        self.deleteSessionAction = deleteSessionAction
    }

    /// Loads cached sessions, then starts refresh and socket work.
    func start() async {
        guard !didStart else {
            return
        }
        didStart = true
        await loadCache()
        listenForSocketEvents()
        await refresh(showLoading: isEmpty)
        await userSessionsSocket.connect()
        hasLoaded = true
    }

    /// Tear down socket bindings; `start()` rebinds on the next appearance.
    func unload() {
        socketTask?.cancel()
        socketTask = nil
        didStart = false
        hasConnected = false
        hasLoaded = false
        errorMessage = nil
        nextRepoCursor = nil
        Task { [userSessionsSocket] in
            await userSessionsSocket.disconnect()
        }
    }

    func refresh(showLoading: Bool = false) async {
        if showLoading {
            isLoading = true
        }
        errorMessage = nil
        do {
            let page = try await sessionsAPI.listSessions()
            replaceCachedList(with: page)
        } catch {
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
        if showLoading {
            isLoading = false
        }
    }

    func archive(_ session: SessionSummaryModel) async {
        errorMessage = nil
        do {
            try await archiveSessionAction(session)
        } catch {
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ session: SessionSummaryModel) async {
        errorMessage = nil
        do {
            try await deleteSessionAction(session)
        } catch {
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    private func loadCache() async {
        do {
            _ = try await sessionSummaryStore.load()
        } catch {
            Logger.error(error)
        }
    }

    private func listenForSocketEvents() {
        socketTask = Task { [weak self, userSessionsSocket] in
            for await event in userSessionsSocket.events {
                await self?.handle(event)
            }
        }
    }

    private func handle(_ event: UserSessionsSocketEvent) async {
        switch event {
        case .connectionChanged(.connected):
            if hasConnected {
                await refresh()
            }
            hasConnected = true
        case .connectionChanged:
            break
        case .server(let message):
            await handle(message)
        }
    }

    private func handle(_ message: UserSessionsServerEvent) async {
        switch message {
        case .connected:
            break
        case .summaryCreated(let summary):
            sessionSummaryStore.putSnapshotsToDisk([summary])
        case .summaryUpdated(let summary):
            guard sessionSummaryStore[summary.id] != nil else {
                return
            }
            sessionSummaryStore.putSnapshotsToDisk([summary])
        case .summaryRemoved(let id):
            sessionSummaryStore.delete([id])
        case .resyncRequired:
            await refresh()
        }
    }

    private func replaceCachedList(with page: SessionSummaryPage) {
        nextRepoCursor = page.nextRepoCursor
        let freshIDs = Set(page.summaries.map(\.id))
        let staleIDs = Set(sessionSummaryStore.objectMap.keys).subtracting(freshIDs)
        sessionSummaryStore.delete(staleIDs)
        sessionSummaryStore.putSnapshotsToDisk(page.summaries)
    }

    private static func groups(from sessions: [SessionSummaryModel]) -> [HomeSessionGroup] {
        let grouped = Dictionary(grouping: sessions.filter { !$0.archived }) { $0.repoId }
        return grouped.values
            .compactMap { sessions in
                guard let first = sessions.first else {
                    return nil
                }
                return HomeSessionGroup(
                    repoId: first.repoId,
                    repoFullName: first.repoFullName,
                    sessions: sessions.sorted { $0.createdAt > $1.createdAt }
                )
            }
            .sorted { lhs, rhs in
                (lhs.sessions.first?.createdAt ?? "") > (rhs.sessions.first?.createdAt ?? "")
            }
    }
}
