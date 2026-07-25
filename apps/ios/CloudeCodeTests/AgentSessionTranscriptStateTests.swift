import API
import Combine
import CoreAPI
import Domain
import Entities
import Foundation
import Testing
@testable import CloudeCode

/// Covers stable transcript identity across streaming updates and optimistic
/// message acceptance, plus row/`messagesByID` consistency invariants.
@MainActor
struct AgentSessionTranscriptStateTests {
    @Test func streamingRowBecomesFinalRowInPlace() async throws {
        let viewModel = makeViewModel()
        viewModel.applyStreamingMessage(assistantMessage(id: "server-1", text: "he"))

        let rowID = try #require(viewModel.transcriptRows.last).id
        viewModel.applyAgentFinish(assistantMessage(id: "server-1", text: "hello"))

        let row = try #require(viewModel.transcriptRows.first)
        #expect(viewModel.transcriptRows.count == 1)
        #expect(row.id == rowID)
        #expect(row.messageID == "server-1")
        #expect(!row.isStreaming)
        #expect(viewModel.messagesByID["server-1"]?.text == "hello")
    }

    @Test func agentFinishInvalidatesQueuedStreamCallbacks() async throws {
        let cache = try Cache(container: ModelContainerFactory().make(inMemory: true))
        let messageStore = SessionMessageStore(cache: cache)
        try await messageStore.replace(
            sessionId: "session-1",
            with: [userMessage(id: "user-1")]
        )
        let viewModel = makeViewModel(sessionMessageStore: messageStore)
        await viewModel.loadCachedMessages()
        viewModel.applyStreamingMessage(assistantMessage(id: "assistant-1", text: "Working"))
        let generation = viewModel.streamGeneration
        let queuedCallback = Task { @MainActor in
            await Task.yield()
            guard viewModel.streamGeneration == generation else {
                return
            }
            viewModel.applyStreamingMessage(
                assistantMessage(id: "assistant-1", text: "Stale callback")
            )
        }

        viewModel.applyAgentFinish(assistantMessage(id: "assistant-1", text: "Complete"))
        await queuedCallback.value

        #expect(viewModel.transcriptRows.map(\.messageID) == ["user-1", "assistant-1"])
        #expect(viewModel.messagesByID["assistant-1"]?.text == "Complete")
    }

    @Test func acceptOptimisticUserMessageKeepsRowID() throws {
        let viewModel = makeViewModel()
        viewModel.upsert(optimisticUserMessage(id: "client-1"))

        let rowID = try #require(viewModel.transcriptRows.first).id
        viewModel.acceptOptimisticUserMessage(clientMessageId: "client-1", messageId: "server-9")

        let row = try #require(viewModel.transcriptRows.first)
        #expect(viewModel.transcriptRows.count == 1)
        #expect(row.id == rowID)
        #expect(row.messageID == "server-9")
        #expect(viewModel.messagesByID["client-1"] == nil)
        #expect(viewModel.messagesByID["server-9"]?.isOptimisticUserMessage == false)
    }

    @Test func snapshotRebuildMidStreamDoesNotDuplicateFinishedMessage() async {
        let viewModel = makeViewModel()
        viewModel.applyStreamingMessage(assistantMessage(id: "server-2", text: "partial"))

        // A full snapshot lands mid-stream and already contains the message.
        viewModel.rebuildTranscript(from: [
            userMessage(id: "u1"),
            assistantMessage(id: "server-2", text: "partial")
        ])
        viewModel.applyAgentFinish(assistantMessage(id: "server-2", text: "final"))

        #expect(viewModel.transcriptRows.count == 2)
        #expect(viewModel.transcriptRows.filter { $0.messageID == "server-2" }.count == 1)
        #expect(viewModel.messagesByID["server-2"]?.text == "final")
    }

    @Test func rebuildPreservesExistingRowIDs() throws {
        let viewModel = makeViewModel()
        viewModel.upsert(userMessage(id: "u1"))
        let rowID = try #require(viewModel.transcriptRows.first).id

        viewModel.rebuildTranscript(from: [userMessage(id: "u1"), assistantMessage(id: "a1")])

        #expect(viewModel.transcriptRows.first?.id == rowID)
        #expect(viewModel.transcriptRows.count == 2)
        #expect(viewModel.messagesByID.count == 2)
    }

    @Test func clearStreamingStateRemovesPartialRowAndContent() {
        let viewModel = makeViewModel()
        viewModel.applyStreamingMessage(assistantMessage(id: "partial-1", text: "he"))

        viewModel.clearStreamingState(removeActiveTranscript: true)

        #expect(viewModel.transcriptRows.isEmpty)
        #expect(viewModel.messagesByID["partial-1"] == nil)
        #expect(viewModel.assistantDisplayDataByRowID.isEmpty)
    }

    @Test func cachedMessagesBuildImmediatelyWithCachedProvider() async throws {
        let messageStore = SessionMessageStore()
        try await messageStore.replace(
            sessionId: "session-1",
            with: [assistantMessage(id: "a1")]
        )
        let builder = RecordingTranscriptBuilder()
        let viewModel = makeViewModel(
            provider: .claudeCode,
            sessionMessageStore: messageStore,
            transcriptBuilder: builder
        )

        await viewModel.loadCachedMessages()

        #expect(viewModel.hasLoadedMessages)
        #expect(viewModel.transcriptRows.map(\.messageID) == ["a1"])
        #expect(builder.providers == [.claudeCode])
    }

    @Test func cachedMessagesUseLegacyFallbackWhenSummaryProviderIsMissing() async throws {
        let messageStore = SessionMessageStore()
        try await messageStore.replace(
            sessionId: "session-1",
            with: [assistantMessage(id: "a1")]
        )
        let builder = RecordingTranscriptBuilder()
        let viewModel = makeViewModel(
            provider: nil,
            sessionMessageStore: messageStore,
            transcriptBuilder: builder
        )

        await viewModel.loadCachedMessages()

        #expect(viewModel.hasLoadedMessages)
        #expect(viewModel.transcriptRows.map(\.messageID) == ["a1"])
        #expect(builder.providers == [.unknown("")])

        viewModel.applyLiveState(liveState(provider: .openaiCodex))

        #expect(builder.providers == [.unknown(""), .openaiCodex])
    }

    @Test func matchingLiveProviderDoesNotRebuildCachedTranscript() async throws {
        let messageStore = SessionMessageStore()
        try await messageStore.replace(
            sessionId: "session-1",
            with: [assistantMessage(id: "a1")]
        )
        let builder = RecordingTranscriptBuilder()
        let viewModel = makeViewModel(
            provider: .claudeCode,
            sessionMessageStore: messageStore,
            transcriptBuilder: builder
        )
        await viewModel.loadCachedMessages()

        viewModel.applyLiveState(liveState(provider: .claudeCode))

        #expect(builder.providers == [.claudeCode])
    }

    @Test func liveProviderReplacesDifferingCachedSummaryProvider() async throws {
        let messageStore = SessionMessageStore()
        try await messageStore.replace(
            sessionId: "session-1",
            with: [assistantMessage(id: "a1")]
        )
        let builder = RecordingTranscriptBuilder()
        let viewModel = makeViewModel(
            provider: .claudeCode,
            sessionMessageStore: messageStore,
            transcriptBuilder: builder
        )
        await viewModel.loadCachedMessages()

        viewModel.applyLiveState(liveState(provider: .openaiCodex))
        viewModel.applyLiveState(liveState(provider: .openaiCodex))

        #expect(builder.providers == [.claudeCode, .openaiCodex])
        #expect(viewModel.session?.provider == .claudeCode)
    }

    @Test func livePendingUserMessageReconcilesOptimisticRow() throws {
        let viewModel = makeViewModel()
        viewModel.upsert(optimisticUserMessage(id: "client-1"))
        let rowID = try #require(viewModel.transcriptRows.first).id

        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            pendingUserMessage: userMessage(id: "server-1")
        ))

        let row = try #require(viewModel.transcriptRows.first)
        #expect(viewModel.transcriptRows.count == 1)
        #expect(row.id == rowID)
        #expect(row.messageID == "server-1")
        #expect(viewModel.messagesByID["client-1"] == nil)
        #expect(viewModel.messagesByID["server-1"]?.isOptimisticUserMessage == false)
    }

    @Test func livePendingUserMessageSurvivesEmptySyncAndDurableConfirmation() async {
        let viewModel = makeViewModel()
        let pendingMessage = userMessage(id: "server-1")
        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            pendingUserMessage: pendingMessage
        ))

        await viewModel.handle(.syncResponse(SessionSyncSnapshot(
            messages: [],
            pendingChunks: [],
            pendingMessageMetadata: nil,
            activeTurnUserMessageId: nil
        )))
        viewModel.applyLiveState(liveState(provider: .claudeCode))
        viewModel.applyUserMessage(pendingMessage)

        #expect(viewModel.transcriptRows.map(\.messageID) == ["server-1"])
        #expect(viewModel.messagesByID["server-1"]?.text == "hello")
    }

    @Test func syncKeepsClientOptimisticMessageOutOfPersistentCache() async throws {
        let messageStore = SessionMessageStore()
        let viewModel = makeViewModel(sessionMessageStore: messageStore)
        viewModel.upsert(optimisticUserMessage(id: "client-1"))

        await viewModel.handle(.syncResponse(SessionSyncSnapshot(
            messages: [],
            pendingChunks: [],
            pendingMessageMetadata: nil,
            activeTurnUserMessageId: nil
        )))
        let cachedMessages = try await messageStore.messages(sessionId: "session-1")

        #expect(viewModel.transcriptRows.map(\.messageID) == ["client-1"])
        #expect(cachedMessages.isEmpty)
    }

    @Test func abortedMetadataMarksAssistantMessageInterrupted() {
        let message = SessionMessage(
            id: "a1",
            role: .assistant,
            text: "partial",
            metadata: .object(["aborted": .bool(true)])
        )

        #expect(message.isAborted)
        #expect(!assistantMessage(id: "a2").isAborted)
    }

    @Test func respondingSessionKeepsComposerEditableAndOffersInterrupt() {
        let viewModel = makeViewModel()
        var readyState = liveState(provider: .claudeCode)
        readyState.status = .ready
        viewModel.applyLiveState(readyState)
        viewModel.connectionState = .connected
        viewModel.isWaitingForResponse = true
        viewModel.draftText = "follow-up"

        #expect(viewModel.composerPlaceholder == "Send a message...")
        #expect(viewModel.canInterruptResponse)
        #expect(!viewModel.canSubmitDraft)
    }

    @Test func preparingSessionDoesNotOfferInterruptBeforeLiveStateHydrates() {
        let viewModel = makeViewModel()
        viewModel.connectionState = .connected
        viewModel.isWaitingForResponse = true

        #expect(viewModel.clientState.status == .preparing)
        #expect(!viewModel.canInterruptResponse)
    }

    @Test func creatingSessionUsesStablePlaceholderAndCannotInterrupt() {
        let viewModel = makeViewModel()
        viewModel.isCreatingSession = true

        #expect(viewModel.composerPlaceholder == "Send a message...")
        #expect(!viewModel.canInterruptResponse)
    }
}

extension AgentSessionTranscriptStateTests {
    struct StubTranscriptBuilder: AgentSessionTranscriptBuilding {
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

    final class RecordingTranscriptBuilder: AgentSessionTranscriptBuilding {
        private(set) var providers: [AgentProviderID?] = []

        func build(
            message: SessionMessage,
            providerId: AgentProviderID?
        ) -> [AgentSessionRenderItem] {
            providers.append(providerId)
            return []
        }

        func finalResponseStartIndex(renderItems: [AgentSessionRenderItem]) -> Int? {
            nil
        }
    }

    struct StubAttachmentsAPI: AttachmentsAPIProviding {
        func uploadImages(
            _ files: [AttachmentUploadFile],
            sessionId: String?
        ) async throws -> [UploadedAttachment] {
            []
        }

        func deleteAttachment(id attachmentId: String) async throws {}
    }

    struct StubModelsAPI: ModelsAPIProviding {
        func models() async throws -> ModelsResponse {
            throw URLError(.badServerResponse)
        }
    }

    struct StubSessionsAPI: SessionsAPIProviding {
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
            throw URLError(.badServerResponse)
        }

        func pullRequest(sessionId: String) async throws -> PullRequestStatusResponse {
            throw URLError(.badServerResponse)
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

    func makeViewModel(
        provider: AgentProviderID? = nil,
        modelsAPI: any ModelsAPIProviding = StubModelsAPI(),
        sessionMessageStore: SessionMessageStore? = nil,
        transcriptBuilder: any AgentSessionTranscriptBuilding = StubTranscriptBuilder(),
        hapticFeedback: any AgentSessionHapticFeedbackProviding = NoopHapticFeedback()
    ) -> AgentSessionViewModel {
        let sessionMessageStore = sessionMessageStore ?? SessionMessageStore()
        let sessionSummaryStore = SessionSummaryStore()
        let sessionsAPI = StubSessionsAPI()
        return AgentSessionViewModel(
            context: .session(makeSession(provider: provider)),
            modelCatalogStore: ModelCatalogStore(modelsAPI: modelsAPI),
            // Unused in session mode: preferences only seed draft selections.
            preferences: NewSessionPreferences(userDefaults: UserDefaults(
                suiteName: "AgentSessionTranscriptStateTests"
            ) ?? .standard),
            makeSocket: { sessionId in
                // Never dialed: these tests exercise state transitions without connecting.
                SessionSocket(
                    baseURL: URL(fileURLWithPath: "/dev/null"),
                    sessionId: sessionId,
                    tokenCache: WebSocketTokenCache { throw URLError(.userAuthenticationRequired) }
                )
            },
            sessionMessageStore: sessionMessageStore,
            sessionSummaryStore: sessionSummaryStore,
            transcriptBuilder: transcriptBuilder,
            sessionsAPI: sessionsAPI,
            attachmentsAPI: StubAttachmentsAPI(),
            renameSessionAction: RenameSessionAction(
                sessionsAPI: sessionsAPI,
                sessionSummaryStore: sessionSummaryStore
            ),
            archiveSessionAction: ArchiveSessionAction(
                sessionsAPI: sessionsAPI,
                sessionSummaryStore: sessionSummaryStore
            ),
            deleteSessionAction: DeleteSessionAction(
                sessionsAPI: sessionsAPI,
                sessionSummaryStore: sessionSummaryStore
            ),
            sessionCreatedSubject: PassthroughSubject<String, Never>(),
            hapticFeedback: hapticFeedback
        )
    }

    func makeSession(provider: AgentProviderID?) -> SessionSummaryModel {
        SessionSummaryModel(SessionSummary(
            id: "session-1",
            repoId: 1,
            repoFullName: "octo/repo",
            provider: provider,
            archived: false,
            workingState: "idle",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            hasUnread: false
        ))
    }

    func liveState(
        provider: AgentProviderID,
        pendingUserMessage: SessionMessage? = nil,
        activeTurnUserMessageID: String? = nil,
        setupRun: SessionClientState.SessionSetupRun? = nil
    ) -> SessionClientState {
        var state = SessionClientState.empty
        state.agentSettings = .init(
            provider: provider,
            model: "model",
            effort: "high",
            maxTokens: 8_192
        )
        state.pendingUserMessage = pendingUserMessage
        state.activeTurnUserMessageId = activeTurnUserMessageID
        state.sessionSetupRun = setupRun
        return state
    }

    func userMessage(id: String, text: String = "hello") -> SessionMessage {
        SessionMessage(id: id, role: .user, text: text)
    }

    func optimisticUserMessage(id: String, text: String = "hello") -> SessionMessage {
        SessionMessage(
            id: id,
            role: .user,
            text: text,
            metadata: .object(["optimistic": .bool(true)])
        )
    }

    func assistantMessage(id: String, text: String = "hi") -> SessionMessage {
        SessionMessage(id: id, role: .assistant, text: text)
    }
}
