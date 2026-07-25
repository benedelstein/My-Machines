import API
import Combine
import CoreAPI
import Domain
import Entities
import Foundation
import Testing
@testable import CloudeCode

@MainActor
extension AgentSessionTranscriptStateTests {
    @Test func cachedClientStateRestoresBeforeCachedTranscript() async throws {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .openaiCodex, isResponding: true))
        let messageStore = SessionMessageStore()
        try await messageStore.replace(
            sessionId: "session-1",
            with: [assistantMessage(id: "assistant-1")]
        )
        let builder = RecordingTranscriptBuilder()
        let viewModel = makeViewModel(
            provider: .claudeCode,
            sessionMessageStore: messageStore,
            sessionClientStateStore: stateStore,
            transcriptBuilder: builder
        )

        await viewModel.loadCachedClientState()
        await viewModel.loadCachedMessages()

        #expect(viewModel.hasHydratedClientState)
        #expect(viewModel.clientState.repoFullName == "cached/repo")
        #expect(viewModel.clientState.status == .ready)
        #expect(viewModel.clientState.sessionSetupRun?.id == "setup-cached")
        #expect(viewModel.clientState.agentMode == .plan)
        #expect(viewModel.transcriptProvider == .openaiCodex)
        #expect(viewModel.isResponding)
        #expect(builder.providers == [.openaiCodex])
    }

    @Test func cachedClientStateWinsOverSummaryValues() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(
            provider: .openaiCodex,
            pullRequest: nil,
            pushedBranch: nil,
            isResponding: false
        ))
        let summary = makeSession(
            provider: .claudeCode,
            title: "Cached title",
            repoFullName: "summary/repo",
            status: .preparing,
            workingState: "responding",
            pushedBranch: "summary-branch",
            pullRequest: .init(
                url: "https://github.com/summary/repo/pull/1",
                number: 1,
                state: "open"
            )
        )
        let viewModel = makeViewModel(
            context: .session(summary),
            sessionClientStateStore: stateStore
        )

        await viewModel.loadCachedClientState()

        #expect(viewModel.repoFullNameForDisplay == "cached/repo")
        #expect(viewModel.sessionStatusForDisplay == .ready)
        #expect(viewModel.transcriptProvider == .openaiCodex)
        #expect(viewModel.pushedBranchForDisplay == nil)
        #expect(viewModel.pullRequestForDisplay == nil)
        #expect(!viewModel.isResponding)
        #expect(viewModel.session?.title == "Cached title")
    }

    @Test func summarySeedsPresentationWhenClientStateCacheIsMissing() async {
        let summary = makeSession(
            provider: .claudeCode,
            title: "Summary title",
            repoFullName: "summary/repo",
            status: .ready,
            workingState: "responding",
            pushedBranch: "summary-branch",
            pullRequest: .init(
                url: "https://github.com/summary/repo/pull/2",
                number: 2,
                state: "open"
            )
        )
        let viewModel = makeViewModel(context: .session(summary))

        await viewModel.loadCachedClientState()

        #expect(!viewModel.hasHydratedClientState)
        #expect(viewModel.repoFullNameForDisplay == "summary/repo")
        #expect(viewModel.sessionStatusForDisplay == .ready)
        #expect(viewModel.transcriptProvider == .claudeCode)
        #expect(viewModel.pushedBranchForDisplay == "summary-branch")
        #expect(viewModel.createdPullRequestURL?.absoluteString == "https://github.com/summary/repo/pull/2")
        #expect(viewModel.isResponding)
        #expect(viewModel.session?.title == "Summary title")
    }

    @Test func liveStateReplacesAndPersistsCachedSnapshot() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .claudeCode, isResponding: true))
        let viewModel = makeViewModel(sessionClientStateStore: stateStore)
        await viewModel.loadCachedClientState()
        var live = liveState(provider: .openaiCodex)
        live.repoFullName = "live/repo"
        live.status = .setupFailed
        live.pushedBranch = "live-branch"
        live.baseBranch = "develop"
        live.agentMode = .edit
        live.pullRequest = .failed(error: "failed", details: nil)

        viewModel.applyLiveState(live)

        let persisted = stateStore["session-1"]
        #expect(persisted?.repoFullName == "live/repo")
        #expect(persisted?.status == .setupFailed)
        #expect(persisted?.agentSettings.provider == .openaiCodex)
        #expect(persisted?.pushedBranch == "live-branch")
        #expect(persisted?.baseBranch == "develop")
        #expect(persisted?.pullRequest == .failed(error: "failed", details: nil))
        #expect(persisted?.isResponding == false)
    }

    @Test func inactiveSyncClearsCachedRespondingState() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .claudeCode, isResponding: true))
        let viewModel = makeViewModel(sessionClientStateStore: stateStore)
        await viewModel.loadCachedClientState()

        await viewModel.handle(.syncResponse(SessionSyncSnapshot(
            messages: [],
            pendingChunks: [],
            pendingMessageMetadata: nil,
            activeTurnUserMessageId: nil
        )))

        #expect(!viewModel.isResponding)
        #expect(stateStore["session-1"]?.isResponding == false)
    }

    @Test func draftDoesNotRestoreSessionClientState() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .openaiCodex, isResponding: true))
        let preferences = NewSessionPreferences(userDefaults: UserDefaults(
            suiteName: "AgentSessionClientStateCacheTests-\(UUID().uuidString)"
        ) ?? .standard)
        let sessionsAPI = StubSessionsAPI()
        let draft = NewSessionDraft(
            sessionsAPI: sessionsAPI,
            reposAPI: UnavailableReposAPI(),
            environmentsStore: RepoEnvironmentsStore { _ in [] },
            preferences: preferences,
            githubInstallationStore: GitHubInstallationStore(
                authAPI: UnavailableAuthAPI(),
                oauthRedirectURI: "cloudecode-dev://auth/callback"
            )
        )
        let viewModel = makeViewModel(
            context: .draft(draft),
            sessionClientStateStore: stateStore
        )

        await viewModel.loadCachedClientState()
        viewModel.persistClientStateIfNeeded(force: true)

        #expect(!viewModel.hasHydratedClientState)
        #expect(viewModel.clientState == .empty)
        #expect(stateStore["session-1"]?.agentSettings.provider == .openaiCodex)
    }

    @Test func unbindSavesBeforeResettingRespondingState() async {
        let stateStore = SessionClientStateStore()
        let viewModel = makeViewModel(sessionClientStateStore: stateStore)
        var live = liveState(
            provider: .claudeCode,
            activeTurnUserMessageID: "user-1"
        )
        live.pushedBranch = "before-unbind"
        viewModel.applyLiveState(live)
        viewModel.clientState.pushedBranch = "saved-on-unbind"

        viewModel.unbind()

        #expect(stateStore["session-1"]?.pushedBranch == "saved-on-unbind")
        #expect(stateStore["session-1"]?.isResponding == true)
        #expect(!viewModel.isResponding)
    }

    @Test func unbindDoesNotRecreateSuccessfullyDeletedClientState() async {
        let stateStore = SessionClientStateStore()
        let viewModel = makeViewModel(
            sessionsAPI: StubSessionsAPI(deleteSucceeds: true),
            sessionClientStateStore: stateStore
        )
        viewModel.applyLiveState(liveState(provider: .claudeCode))

        let didDelete = await viewModel.deleteSession()
        viewModel.unbind()

        #expect(didDelete)
        #expect(stateStore["session-1"] == nil)
    }

    @Test func cancelledHydrationDoesNotApplyCachedClientState() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .openaiCodex, isResponding: true))
        let viewModel = makeViewModel(sessionClientStateStore: stateStore)
        let hydrationTask = Task {
            await viewModel.loadCachedClientState()
        }

        hydrationTask.cancel()
        await hydrationTask.value

        #expect(!viewModel.hasHydratedClientState)
        #expect(viewModel.clientState == .empty)
        #expect(!viewModel.isResponding)
    }

    @Test func successfulDeletionClearsCachedClientState() async throws {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .claudeCode, isResponding: false))
        let summaryStore = SessionSummaryStore()
        let session = summaryStore.putMemory([makeSession(provider: .claudeCode).snapshot])[0]
        let action = DeleteSessionAction(
            sessionsAPI: StubSessionsAPI(deleteSucceeds: true),
            sessionSummaryStore: summaryStore,
            sessionClientStateStore: stateStore
        )

        try await action(session)

        #expect(stateStore["session-1"] == nil)
    }

    @Test func failedDeletionRetainsCachedClientState() async {
        let stateStore = SessionClientStateStore()
        stateStore.save(cachedState(provider: .claudeCode, isResponding: false))
        let summaryStore = SessionSummaryStore()
        let session = summaryStore.putMemory([makeSession(provider: .claudeCode).snapshot])[0]
        let action = DeleteSessionAction(
            sessionsAPI: StubSessionsAPI(),
            sessionSummaryStore: summaryStore,
            sessionClientStateStore: stateStore
        )

        do {
            try await action(session)
            Issue.record("Expected session deletion to fail")
        } catch {
            #expect(error is URLError)
        }

        #expect(stateStore["session-1"] != nil)
    }

    private func cachedState(
        provider: AgentProviderID,
        pullRequest: SessionClientState.PullRequest? = .created(
            url: "https://github.com/cached/repo/pull/3",
            number: 3,
            state: "open"
        ),
        pushedBranch: String? = "cached-branch",
        isResponding: Bool
    ) -> SessionClientStateSnapshot {
        SessionClientStateSnapshot(
            id: "session-1",
            repoFullName: "cached/repo",
            status: .ready,
            sessionSetupRun: cachedSetupRun(),
            agentSettings: .init(
                provider: provider,
                model: "cached-model",
                effort: "high",
                maxTokens: 8_192
            ),
            pullRequest: pullRequest,
            pushedBranch: pushedBranch,
            baseBranch: "main",
            agentMode: .plan,
            isResponding: isResponding
        )
    }

    private func cachedSetupRun() -> SessionClientState.SessionSetupRun {
        SessionClientState.SessionSetupRun(
            id: "setup-cached",
            status: .completed,
            startedAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T00:01:00Z",
            tasks: []
        )
    }
}

private struct UnavailableReposAPI: ReposAPIProviding {
    func listRepos(limit: Int?, cursor: String?) async throws -> ListReposResponse {
        throw URLError(.resourceUnavailable)
    }

    func searchRepos(query: String, limit: Int?) async throws -> SearchReposResponse {
        throw URLError(.resourceUnavailable)
    }

    func branches(repoId: Int, limit: Int?, cursor: String?) async throws -> ListBranchesResponse {
        throw URLError(.resourceUnavailable)
    }
}

private struct UnavailableAuthAPI: AuthAPIProviding {
    func githubInstallationPage(redirectUri: String) async throws -> AuthorizePage {
        throw URLError(.resourceUnavailable)
    }

    func me() async throws -> User {
        throw URLError(.resourceUnavailable)
    }
}
