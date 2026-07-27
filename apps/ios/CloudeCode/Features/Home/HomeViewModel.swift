import API
import Entities
import Domain
import Foundation

struct HomeSessionGroup: Identifiable, Hashable {
    let repoId: Int
    let repoFullName: String
    var sessionPage: CursorPage<SessionSummaryModel>

    var id: Int { repoId }
    var sessions: [SessionSummaryModel] { sessionPage.values }
    var hasNextPage: Bool { sessionPage.hasNextPage }
}

@MainActor
@Observable
final class HomeViewModel {
    private let sessionsAPI: any SessionsAPIProviding
    private let sessionSummaryStore: SessionSummaryStore
    private let userSessionsSocket: UserSessionsSocket
    private let archiveSessionAction: ArchiveSessionAction
    private let deleteSessionAction: DeleteSessionAction
    private var didStart = false
    private var hasConnected = false
    private var socketTask: Task<Void, Never>?
    private var paginationGeneration = 0
    private var groupPage = CursorPage<HomeSessionGroup>(values: [], nextCursor: nil)

    private(set) var isLoading = false
    private(set) var isLoadingMoreRepositories = false
    private(set) var loadingSessionRepoIDs = Set<Int>()
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?

    var groups: [HomeSessionGroup] {
        groupPage.values
    }

    var hasNextRepositoryPage: Bool {
        groupPage.hasNextPage
    }

    var isEmpty: Bool {
        groups.isEmpty
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
}

extension HomeViewModel {
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
        isLoadingMoreRepositories = false
        loadingSessionRepoIDs.removeAll()
        paginationGeneration += 1
        Task { [userSessionsSocket] in
            await userSessionsSocket.disconnect()
        }
    }

    func refresh(showLoading: Bool = false) async {
        paginationGeneration += 1
        let generation = paginationGeneration
        isLoadingMoreRepositories = false
        loadingSessionRepoIDs.removeAll()
        if showLoading {
            isLoading = true
        }
        defer {
            if showLoading, generation == paginationGeneration {
                isLoading = false
            }
        }
        errorMessage = nil
        do {
            let page = try await sessionsAPI.listSessions()
            guard generation == paginationGeneration else {
                return
            }
            replaceList(with: page)
        } catch {
            guard generation == paginationGeneration else {
                return
            }
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    /// Loads the next page of repository groups, if one is available.
    func loadMoreRepositories() async {
        guard !isLoadingMoreRepositories,
              let cursor = groupPage.nextCursor else {
            return
        }

        let generation = paginationGeneration
        isLoadingMoreRepositories = true
        errorMessage = nil
        defer {
            if generation == paginationGeneration {
                isLoadingMoreRepositories = false
            }
        }

        do {
            let page = try await sessionsAPI.listSessions(
                repoId: nil,
                repoCursor: cursor,
                sessionCursor: nil,
                repoLimit: nil,
                sessionLimit: nil
            )
            guard generation == paginationGeneration else {
                return
            }
            appendRepositoryPage(page)
        } catch {
            guard generation == paginationGeneration else {
                return
            }
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    /// Loads the next page of sessions in a repository, if one is available.
    func loadMoreSessions(repoId: Int) async {
        guard !loadingSessionRepoIDs.contains(repoId),
              let group = groups.first(where: { $0.repoId == repoId }),
              let cursor = group.sessionPage.nextCursor else {
            return
        }

        let generation = paginationGeneration
        loadingSessionRepoIDs.insert(repoId)
        errorMessage = nil
        defer {
            if generation == paginationGeneration {
                loadingSessionRepoIDs.remove(repoId)
            }
        }

        do {
            let page = try await sessionsAPI.listSessions(
                repoId: repoId,
                repoCursor: nil,
                sessionCursor: cursor,
                repoLimit: nil,
                sessionLimit: nil
            )
            guard generation == paginationGeneration else {
                return
            }
            appendSessionPage(page, repoId: repoId)
        } catch {
            guard generation == paginationGeneration else {
                return
            }
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    func archive(_ session: SessionSummaryModel) async {
        errorMessage = nil
        do {
            try await archiveSessionAction(session)
            removeSession(id: session.id)
        } catch {
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ session: SessionSummaryModel) async {
        errorMessage = nil
        do {
            try await deleteSessionAction(session)
            removeSession(id: session.id)
        } catch {
            Logger.error(error)
            errorMessage = error.localizedDescription
        }
    }
}

private extension HomeViewModel {
    func loadCache() async {
        do {
            let cachedSessions = try await sessionSummaryStore.load()
            groupPage = CursorPage(
                values: Self.groups(from: cachedSessions),
                nextCursor: nil
            )
        } catch {
            Logger.error(error)
        }
    }

    func listenForSocketEvents() {
        socketTask = Task { [weak self, userSessionsSocket] in
            for await event in userSessionsSocket.events {
                await self?.handle(event)
            }
        }
    }

    func handle(_ event: UserSessionsSocketEvent) async {
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

    func handle(_ message: UserSessionsServerEvent) async {
        switch message {
        case .connected:
            break
        case .summaryCreated(let summary):
            sessionSummaryStore.putSnapshotsToDisk([summary])
            await refresh()
        case .summaryUpdated(let summary):
            guard sessionSummaryStore[summary.id] != nil else {
                return
            }
            sessionSummaryStore.putSnapshotsToDisk([summary])
        case .summaryRemoved(let id):
            sessionSummaryStore.delete([id])
            removeSession(id: id)
        case .resyncRequired:
            await refresh()
        }
    }

    func replaceList(with page: SessionSummaryPage) {
        groupPage = CursorPage(
            values: page.values.map { makeGroup($0) },
            nextCursor: page.nextCursor
        )
    }

    func appendRepositoryPage(_ page: SessionSummaryPage) {
        let incomingGroups = page.values.map { makeGroup($0) }
        var mergedGroups = groups

        for incomingGroup in incomingGroups {
            if let index = mergedGroups.firstIndex(where: { $0.repoId == incomingGroup.repoId }) {
                mergedGroups[index] = merging(mergedGroups[index], with: incomingGroup)
            } else {
                mergedGroups.append(incomingGroup)
            }
        }

        groupPage = CursorPage(
            values: mergedGroups,
            nextCursor: page.nextCursor
        )
    }

    func appendSessionPage(_ page: SessionSummaryPage, repoId: Int) {
        guard let groupPageValue = page.values.first(where: { $0.repoId == repoId }),
              let index = groups.firstIndex(where: { $0.repoId == repoId }) else {
            clearSessionCursor(repoId: repoId)
            return
        }

        var mergedGroups = groups
        mergedGroups[index] = merging(mergedGroups[index], with: makeGroup(groupPageValue))
        groupPage = CursorPage(
            values: mergedGroups,
            nextCursor: groupPage.nextCursor
        )
    }

    func clearSessionCursor(repoId: Int) {
        guard let index = groups.firstIndex(where: { $0.repoId == repoId }) else {
            return
        }

        var updatedGroups = groups
        let group = updatedGroups[index]
        updatedGroups[index].sessionPage = CursorPage(
            values: group.sessions,
            nextCursor: nil
        )
        groupPage = CursorPage(
            values: updatedGroups,
            nextCursor: groupPage.nextCursor
        )
    }

    func makeGroup(_ page: SessionRepoPage) -> HomeSessionGroup {
        HomeSessionGroup(
            repoId: page.repoId,
            repoFullName: page.repoFullName,
            sessionPage: CursorPage(
                values: sessionSummaryStore.putSnapshotsToDisk(page.sessions.values),
                nextCursor: page.sessions.nextCursor
            )
        )
    }

    func merging(
        _ current: HomeSessionGroup,
        with incoming: HomeSessionGroup
    ) -> HomeSessionGroup {
        var seenIDs = Set(current.sessions.map(\.id))
        let newSessions = incoming.sessions.filter { seenIDs.insert($0.id).inserted }
        return HomeSessionGroup(
            repoId: current.repoId,
            repoFullName: incoming.repoFullName,
            sessionPage: CursorPage(
                values: current.sessions + newSessions,
                nextCursor: incoming.sessionPage.nextCursor
            )
        )
    }

    func removeSession(id: String) {
        let updatedGroups = groups.compactMap { group -> HomeSessionGroup? in
            let sessions = group.sessions.filter { $0.id != id && !$0.archived }
            guard !sessions.isEmpty || group.hasNextPage else {
                return nil
            }
            return HomeSessionGroup(
                repoId: group.repoId,
                repoFullName: group.repoFullName,
                sessionPage: CursorPage(
                    values: sessions,
                    nextCursor: group.sessionPage.nextCursor
                )
            )
        }
        groupPage = CursorPage(
            values: updatedGroups,
            nextCursor: groupPage.nextCursor
        )
    }

    static func groups(from sessions: [SessionSummaryModel]) -> [HomeSessionGroup] {
        let grouped = Dictionary(grouping: sessions.filter { !$0.archived }) { $0.repoId }
        return grouped.values
            .compactMap { sessions in
                guard let first = sessions.first else {
                    return nil
                }
                return HomeSessionGroup(
                    repoId: first.repoId,
                    repoFullName: first.repoFullName,
                    sessionPage: CursorPage(
                        values: sessions.sorted { $0.createdAt > $1.createdAt },
                        nextCursor: nil
                    )
                )
            }
            .sorted { lhs, rhs in
                (lhs.sessions.first?.createdAt ?? "") > (rhs.sessions.first?.createdAt ?? "")
            }
    }
}
