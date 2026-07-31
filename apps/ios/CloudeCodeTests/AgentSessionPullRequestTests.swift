import API
import Combine
import CoreAPI
import Domain
import Entities
import Foundation
import Testing
@testable import CloudeCode

@MainActor
struct AgentSessionPullRequestTests {
    @Test func summarySeedsBranchBarBeforeLiveStateArrives() {
        let viewModel = makeViewModel(
            pushedBranch: "codex/mobile-branch-bar",
            pullRequest: Domain.SessionSummary.PullRequest(
                url: "https://github.com/example/repo/pull/42",
                number: 42,
                state: "open"
            )
        )

        #expect(viewModel.clientState.pushedBranch == "codex/mobile-branch-bar")
        #expect(viewModel.createdPullRequestURL?.absoluteString == "https://github.com/example/repo/pull/42")
    }

    @Test func liveFailureOverridesSummaryPullRequest() {
        let viewModel = makeViewModel(
            pushedBranch: "codex/mobile-branch-bar",
            pullRequest: Domain.SessionSummary.PullRequest(
                url: "https://github.com/example/repo/pull/42",
                number: 42,
                state: "open"
            )
        )
        var state = SessionClientState.empty
        state.pushedBranch = "codex/mobile-branch-bar"
        state.pullRequest = .failed(error: "Creation failed", details: "Missing repository access")

        viewModel.applyLiveState(state)

        #expect(viewModel.createdPullRequestURL == nil)
        #expect(viewModel.pullRequestErrorMessage == "Missing repository access")
    }

    @Test func createPullRequestUpdatesLiveAndSummaryState() async {
        let api = RecordingSessionsAPI(
            createOutcomes: [.success(PullRequestResponse(
                url: "https://github.com/example/repo/pull/42",
                number: 42,
                state: "open"
            ))]
        )
        let viewModel = makeViewModel(api: api, pushedBranch: "codex/mobile-branch-bar")

        let url = await viewModel.createPullRequest()

        #expect(url?.absoluteString == "https://github.com/example/repo/pull/42")
        #expect(await api.createCallCount == 1)
        #expect(viewModel.session?.pullRequest?.number == 42)
        guard case .created(_, let number, let state) = viewModel.clientState.pullRequest else {
            Issue.record("Expected a created pull request")
            return
        }
        #expect(number == 42)
        #expect(state == "open")
    }

    @Test func failedCreationCanBeRetried() async {
        let api = RecordingSessionsAPI(createOutcomes: [
            .failure,
            .success(PullRequestResponse(
                url: "https://github.com/example/repo/pull/43",
                number: 43,
                state: "open"
            ))
        ])
        let viewModel = makeViewModel(api: api, pushedBranch: "codex/mobile-branch-bar")

        let firstURL = await viewModel.createPullRequest()
        #expect(firstURL == nil)
        #expect(viewModel.pullRequestOperationErrorMessage != nil)

        let retryURL = await viewModel.createPullRequest()
        #expect(retryURL?.absoluteString == "https://github.com/example/repo/pull/43")
        #expect(viewModel.pullRequestOperationErrorMessage == nil)
        #expect(await api.createCallCount == 2)
    }

    @Test func refreshMapsMergedFlagToMergedState() async {
        let api = RecordingSessionsAPI(pullRequestResponses: [PullRequestStatusResponse(
            url: "https://github.com/example/repo/pull/42",
            number: 42,
            state: "closed",
            merged: true
        )])
        let viewModel = makeViewModel(api: api, pushedBranch: "codex/mobile-branch-bar")
        viewModel.applyLiveState(openPullRequestState())

        await viewModel.refreshPullRequestStatus()

        guard case .created(_, _, let state) = viewModel.clientState.pullRequest else {
            Issue.record("Expected a created pull request")
            return
        }
        #expect(state == "merged")
        #expect(await api.pullRequestCallCount == 1)
    }

    @Test func pollingRefreshesImmediatelyAndStopsWhenMerged() async throws {
        let api = RecordingSessionsAPI(pullRequestResponses: [PullRequestStatusResponse(
            url: "https://github.com/example/repo/pull/42",
            number: 42,
            state: "closed",
            merged: true
        )])
        let viewModel = makeViewModel(
            api: api,
            pushedBranch: "codex/mobile-branch-bar",
            pollInterval: .milliseconds(5)
        )
        viewModel.applyLiveState(openPullRequestState())
        viewModel.isBound = true

        viewModel.updatePullRequestPolling()
        for _ in 0..<20 where await api.pullRequestCallCount == 0 {
            try await Task.sleep(for: .milliseconds(5))
        }

        #expect(await api.pullRequestCallCount == 1)
        #expect(viewModel.pullRequestPollingTask == nil)
        guard case .created(_, _, let state) = viewModel.clientState.pullRequest else {
            Issue.record("Expected a created pull request")
            return
        }
        #expect(state == "merged")
    }

    private func makeViewModel(
        api: any SessionsAPIProviding = RecordingSessionsAPI(),
        pushedBranch: String? = nil,
        pullRequest: Domain.SessionSummary.PullRequest? = nil,
        pollInterval: Duration = .seconds(30)
    ) -> AgentSessionViewModel {
        let sessionSummaryStore = SessionSummaryStore()
        let sessionClientStateStore = SessionClientStateStore()
        let session = makeSession(pushedBranch: pushedBranch, pullRequest: pullRequest)
        return AgentSessionViewModel(
            context: .session(session),
            modelCatalogStore: ModelCatalogStore(modelsAPI: StubModelsAPI()),
            preferences: NewSessionPreferences(userDefaults: UserDefaults(
                suiteName: "AgentSessionPullRequestTests-\(UUID().uuidString)"
            ) ?? .standard),
            makeSocket: makeSocket,
            sessionMessageStore: SessionMessageStore(),
            sessionClientStateStore: sessionClientStateStore,
            sessionSummaryStore: sessionSummaryStore,
            transcriptBuilder: StubTranscriptBuilder(),
            sessionsAPI: api,
            attachmentsAPI: StubAttachmentsAPI(),
            renameSessionAction: RenameSessionAction(
                sessionsAPI: api,
                sessionSummaryStore: sessionSummaryStore
            ),
            archiveSessionAction: ArchiveSessionAction(
                sessionsAPI: api,
                sessionSummaryStore: sessionSummaryStore
            ),
            deleteSessionAction: DeleteSessionAction(
                sessionsAPI: api,
                sessionSummaryStore: sessionSummaryStore,
                sessionClientStateStore: sessionClientStateStore
            ),
            sessionCreatedSubject: PassthroughSubject<String, Never>(),
            pullRequestPollInterval: pollInterval
        )
    }

    private func makeSession(
        pushedBranch: String?,
        pullRequest: Domain.SessionSummary.PullRequest?
    ) -> SessionSummaryModel {
        SessionSummaryModel(SessionSummary(
            id: "session-1",
            repoId: 1,
            repoFullName: "example/repo",
            title: "Session",
            archived: false,
            workingState: "idle",
            pushedBranch: pushedBranch,
            pullRequest: pullRequest,
            createdAt: "2026-07-17T00:00:00Z",
            updatedAt: "2026-07-17T00:00:00Z",
            hasUnread: false
        ))
    }

    private func makeSocket(sessionId: String) -> SessionSocket {
        SessionSocket(
            baseURL: URL(fileURLWithPath: "/dev/null"),
            sessionId: sessionId,
            tokenCache: WebSocketTokenCache { throw URLError(.userAuthenticationRequired) }
        )
    }

    private func openPullRequestState() -> SessionClientState {
        var state = SessionClientState.empty
        state.pushedBranch = "codex/mobile-branch-bar"
        state.pullRequest = .created(
            url: "https://github.com/example/repo/pull/42",
            number: 42,
            state: "open"
        )
        return state
    }
}

private struct StubTranscriptBuilder: AgentSessionTranscriptBuilding {
    func build(
        message: SessionMessage,
        providerId: AgentProviderID?
    ) -> [AgentSessionRenderItem] {
        []
    }

    func finalResponseStartIndex(renderItems: [AgentSessionRenderItem]) -> Int? {
        nil
    }
}

private struct StubAttachmentsAPI: AttachmentsAPIProviding {
    func uploadImages(
        _ files: [AttachmentUploadFile],
        sessionId: String?
    ) async throws -> [UploadedAttachment] {
        []
    }

    func deleteAttachment(id attachmentId: String) async throws {}
}

private struct StubModelsAPI: ModelsAPIProviding {
    func models() async throws -> ModelsResponse {
        throw URLError(.badServerResponse)
    }
}

private actor RecordingSessionsAPI: SessionsAPIProviding {
    enum CreateOutcome: Sendable {
        case success(PullRequestResponse)
        case failure
    }

    private var createOutcomes: [CreateOutcome]
    private var pullRequestResponses: [PullRequestStatusResponse]
    private(set) var createCallCount: Int = 0
    private(set) var pullRequestCallCount: Int = 0

    init(
        createOutcomes: [CreateOutcome] = [],
        pullRequestResponses: [PullRequestStatusResponse] = []
    ) {
        self.createOutcomes = createOutcomes
        self.pullRequestResponses = pullRequestResponses
    }

    func listSessions(
        repoId: Int?,
        repoCursor: String?,
        sessionCursor: String?,
        repoLimit: Int?,
        sessionLimit: Int?
    ) async throws -> SessionSummaryPage {
        throw URLError(.badServerResponse)
    }

    func createSession(_ request: CreateSessionRequest) async throws -> CreateSessionResponse {
        throw URLError(.badServerResponse)
    }

    func session(id: String) async throws -> SessionInfoResponse {
        throw URLError(.badServerResponse)
    }

    func messages(sessionId: String) async throws -> [SessionMessage] {
        throw URLError(.badServerResponse)
    }

    func plan(sessionId: String) async throws -> SessionPlanResponse {
        throw URLError(.badServerResponse)
    }

    func updateTitle(sessionId: String, title: String) async throws -> UpdateSessionTitleResponse {
        throw URLError(.badServerResponse)
    }

    func createPullRequest(sessionId: String) async throws -> PullRequestResponse {
        createCallCount += 1
        guard !createOutcomes.isEmpty else {
            throw URLError(.badServerResponse)
        }
        switch createOutcomes.removeFirst() {
        case .success(let response):
            return response
        case .failure:
            throw URLError(.cannotConnectToHost)
        }
    }

    func pullRequest(sessionId: String) async throws -> PullRequestStatusResponse {
        pullRequestCallCount += 1
        guard !pullRequestResponses.isEmpty else {
            throw URLError(.badServerResponse)
        }
        return pullRequestResponses.removeFirst()
    }

    func archive(sessionId: String) async throws {
        throw URLError(.badServerResponse)
    }

    func delete(sessionId: String) async throws {
        throw URLError(.badServerResponse)
    }

    func sessionWebSocketToken(sessionId: String) async throws -> WebSocketToken {
        throw URLError(.badServerResponse)
    }

    func userSessionsWebSocketToken() async throws -> WebSocketToken {
        throw URLError(.badServerResponse)
    }
}
