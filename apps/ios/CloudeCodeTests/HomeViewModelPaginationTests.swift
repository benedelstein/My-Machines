import API
@testable import CloudeCode
import CoreAPI
import Domain
import Entities
import Foundation
import Testing

@Suite("Home pagination")
@MainActor
struct HomeViewModelPaginationTests {
    @Test func loadsRepositoryAndNestedSessionPagesFromTheirOwnCursors() async {
        let api = PaginationSessionsAPI()
        let store = SessionSummaryStore()
        let viewModel = HomeViewModel(
            sessionsAPI: api,
            sessionSummaryStore: store,
            userSessionsSocket: UserSessionsSocket(
                baseURL: URL(fileURLWithPath: "/dev/null"),
                tokenCache: WebSocketTokenCache {
                    throw PaginationTestError.unexpectedAPICall
                }
            ),
            archiveSessionAction: ArchiveSessionAction(
                sessionsAPI: api,
                sessionSummaryStore: store
            ),
            deleteSessionAction: DeleteSessionAction(
                sessionsAPI: api,
                sessionSummaryStore: store
            )
        )

        await viewModel.refresh()

        #expect(viewModel.groups.map(\.repoId) == [1])
        #expect(viewModel.groups[0].sessions.map(\.id) == ["session-1"])
        #expect(viewModel.groups[0].hasNextPage)
        #expect(viewModel.hasNextRepositoryPage)

        await viewModel.loadMoreSessions(repoId: 1)

        #expect(viewModel.groups[0].sessions.map(\.id) == ["session-1", "session-2"])
        #expect(!viewModel.groups[0].hasNextPage)
        #expect(viewModel.hasNextRepositoryPage)

        await viewModel.loadMoreRepositories()

        #expect(viewModel.groups.map(\.repoId) == [1, 2])
        #expect(viewModel.groups[1].sessions.map(\.id) == ["session-3"])
        #expect(!viewModel.hasNextRepositoryPage)

        let requests = await api.requests
        #expect(requests == [
            PaginationRequest(repoId: nil, repoCursor: nil, sessionCursor: nil),
            PaginationRequest(repoId: 1, repoCursor: nil, sessionCursor: "sessions-2"),
            PaginationRequest(repoId: nil, repoCursor: "repos-2", sessionCursor: nil)
        ])
    }
}

private struct PaginationRequest: Sendable, Equatable {
    let repoId: Int?
    let repoCursor: String?
    let sessionCursor: String?
}

private actor PaginationSessionsAPI: SessionsAPIProviding {
    private(set) var requests: [PaginationRequest] = []

    func listSessions(
        repoId: Int?,
        repoCursor: String?,
        sessionCursor: String?,
        repoLimit: Int?,
        sessionLimit: Int?
    ) async throws -> SessionSummaryPage {
        requests.append(PaginationRequest(
            repoId: repoId,
            repoCursor: repoCursor,
            sessionCursor: sessionCursor
        ))

        switch (repoId, repoCursor, sessionCursor) {
        case (nil, nil, nil):
            return firstPage
        case (1, nil, "sessions-2"):
            return secondSessionPage
        case (nil, "repos-2", nil):
            return secondRepositoryPage
        default:
            throw PaginationTestError.unexpectedAPICall
        }
    }

    func createSession(_ request: CreateSessionRequest) async throws -> CreateSessionResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func session(id: String) async throws -> SessionInfoResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func messages(sessionId: String) async throws -> [SessionMessage] {
        throw PaginationTestError.unexpectedAPICall
    }

    func plan(sessionId: String) async throws -> SessionPlanResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func updateTitle(sessionId: String, title: String) async throws -> UpdateSessionTitleResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func createPullRequest(sessionId: String) async throws -> PullRequestResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func pullRequest(sessionId: String) async throws -> PullRequestStatusResponse {
        throw PaginationTestError.unexpectedAPICall
    }

    func archive(sessionId: String) async throws {
        throw PaginationTestError.unexpectedAPICall
    }

    func delete(sessionId: String) async throws {
        throw PaginationTestError.unexpectedAPICall
    }

    func sessionWebSocketToken(sessionId: String) async throws -> WebSocketToken {
        throw PaginationTestError.unexpectedAPICall
    }

    func userSessionsWebSocketToken() async throws -> WebSocketToken {
        throw PaginationTestError.unexpectedAPICall
    }

    private var firstPage: SessionSummaryPage {
        CursorPage(
            values: [
                SessionRepoPage(
                    repoId: 1,
                    repoFullName: "owner/first",
                    sessions: CursorPage(
                        values: [makeSummary(id: "session-1", repoId: 1)],
                        nextCursor: "sessions-2"
                    )
                )
            ],
            nextCursor: "repos-2"
        )
    }

    private var secondSessionPage: SessionSummaryPage {
        CursorPage(
            values: [
                SessionRepoPage(
                    repoId: 1,
                    repoFullName: "owner/first",
                    sessions: CursorPage(
                        values: [makeSummary(id: "session-2", repoId: 1)],
                        nextCursor: nil
                    )
                )
            ],
            nextCursor: nil
        )
    }

    private var secondRepositoryPage: SessionSummaryPage {
        CursorPage(
            values: [
                SessionRepoPage(
                    repoId: 2,
                    repoFullName: "owner/second",
                    sessions: CursorPage(
                        values: [makeSummary(id: "session-3", repoId: 2)],
                        nextCursor: nil
                    )
                )
            ],
            nextCursor: nil
        )
    }

    private func makeSummary(id: String, repoId: Int) -> Domain.SessionSummary {
        Domain.SessionSummary(
            id: id,
            repoId: repoId,
            repoFullName: repoId == 1 ? "owner/first" : "owner/second",
            title: id,
            archived: false,
            status: .ready,
            workingState: "idle",
            createdAt: "2026-07-27T00:00:00Z",
            updatedAt: "2026-07-27T00:00:00Z",
            hasUnread: false
        )
    }
}

private enum PaginationTestError: Error {
    case unexpectedAPICall
}
