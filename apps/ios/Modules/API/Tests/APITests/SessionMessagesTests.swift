@testable import API
import CoreAPI
import Domain
import Testing

@Suite("Session messages")
struct SessionMessagesTests {
    @Test func uiMessageMapsToDomainMessageWithAllParts() {
        let message = WireUIMessage(
            id: "msg_1",
            role: .assistant,
            parts: [
                .text(.init(text: "First paragraph.")),
                .tool(.init(
                    type: "tool-bash",
                    toolCallId: "call_1",
                    state: .outputAvailable,
                    input: .object(["cmd": .string("ls")]),
                    output: .string("README.md")
                )),
                .text(.init(text: "Second paragraph."))
            ]
        )

        let sessionMessage = SessionMessage(message)

        #expect(sessionMessage.id == "msg_1")
        #expect(sessionMessage.role == .assistant)
        #expect(sessionMessage.text == "First paragraph.\n\nSecond paragraph.")
        #expect(sessionMessage.parts.count == 3)
        guard case .tool(let toolPart) = sessionMessage.parts[1] else {
            Issue.record("Expected tool part to be preserved")
            return
        }
        #expect(toolPart.type == "tool-bash")
        #expect(toolPart.toolCallId == "call_1")
        #expect(toolPart.input == .object(["cmd": .string("ls")]))
        #expect(toolPart.output == .string("README.md"))
    }

    @Test func uiMessageMapsFilePartDimensionsToDomainMessage() {
        let message = WireUIMessage(
            id: "msg_1",
            role: .user,
            parts: [
                .file(.init(
                    mediaType: "image/png",
                    filename: "screenshot.png",
                    url: "/attachments/123e4567-e89b-12d3-a456-426614174000/content",
                    width: 640,
                    height: 480
                ))
            ]
        )

        let sessionMessage = SessionMessage(message)

        guard case .file(let filePart) = sessionMessage.parts.first else {
            Issue.record("Expected file part to be preserved")
            return
        }
        #expect(filePart.width == 640)
        #expect(filePart.height == 480)
    }

    @Test func streamChunkExposesTextDelta() {
        let chunk = SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello")))

        #expect(chunk.textDelta == "Hello")
    }

    @Test func streamChunkIgnoresNonTextDelta() {
        let chunk = SessionStreamChunk(.finish(.init()))

        #expect(chunk.textDelta == nil)
    }

    @Test
    func streamAccumulatorAppendsChunksIncrementally() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hel")))
        ])

        let initialMessage = try await recorder.waitForMessage { $0.text == "Hel" }
        #expect(initialMessage.id == "message-1")

        await accumulator.append([
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "lo"))),
            SessionStreamChunk(.textEnd(.init(id: "text-1"))),
            SessionStreamChunk(.finish(.init(finishReason: .stop)))
        ])

        let finalMessage = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(finalMessage.id == "message-1")
        #expect(await accumulator.errorDescription == nil)
        #expect(await recorder.errors.isEmpty)
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorReducesPendingChunksAllAtOnce() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hel"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "lo"))),
            SessionStreamChunk(.textEnd(.init(id: "text-1"))),
            SessionStreamChunk(.finish(.init(finishReason: .stop)))
        ])

        let message = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(message.id == "message-1")
        #expect(await accumulator.errorDescription == nil)
        await accumulator.finish()
    }

    @Test
    func streamReaderCountsReducerEmissionsRatherThanChunks() async throws {
        let chunks = [
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.startStep(.init())),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello"))),
            SessionStreamChunk(.finishStep(.init())),
            SessionStreamChunk(.finish(.init(finishReason: .stop)))
        ]

        let emissionCount = try await SessionMessageStreamReader.emissionCount(from: chunks)

        #expect(emissionCount == 3)
    }

    @Test
    func streamAccumulatorEmitsOnlyFinalBackfillMessageThenContinuesLive() async throws {
        let initialChunks = [
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hel")))
        ]
        let emissionCount = try await SessionMessageStreamReader.emissionCount(from: initialChunks)
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator(
            initialChunks: initialChunks,
            messageMetadata: SessionStreamMessageMetadata(startedAt: "2026-06-24T00:00:00.000Z")
        )

        #expect(emissionCount == 3)
        let backfilledMessage = try await recorder.waitForMessage { $0.text == "Hel" }
        #expect(backfilledMessage.id == "message-1")
        #expect(backfilledMessage.metadata == .object([
            "startedAt": .string("2026-06-24T00:00:00.000Z")
        ]))
        #expect(await recorder.messageCount == 1)

        await accumulator.append([
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "lo")))
        ])

        let liveMessage = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(liveMessage.id == "message-1")
        #expect(await recorder.messageCount == 2)
        #expect(await accumulator.errorDescription == nil)
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorQueuesLiveChunksWhilePreparingBackfill() async throws {
        let initialText = String(repeating: "a", count: 500)
        let initialChunks = [
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1")))
        ] + initialText.map { character in
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: String(character))))
        }
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator(initialChunks: initialChunks)

        await accumulator.append([
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "b")))
        ])

        let messages = try await recorder.waitForMessageCount(2)
        #expect(messages.map(\.text).contains(initialText))
        #expect(messages.map(\.text).contains(initialText + "b"))
        #expect(messages.allSatisfy { !$0.text.isEmpty })
        #expect(await accumulator.errorDescription == nil)
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorHandlesBackfillWithoutMessageEmissions() async throws {
        let initialChunks = [
            SessionStreamChunk(.finish(.init(finishReason: .stop))),
            SessionStreamChunk(.unknown(type: "future-chunk", rawValue: .object([
                "type": .string("future-chunk")
            ])))
        ]
        let emissionCount = try await SessionMessageStreamReader.emissionCount(from: initialChunks)
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator(initialChunks: initialChunks)

        #expect(emissionCount == 0)
        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello")))
        ])

        let liveMessage = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(liveMessage.id == "message-1")
        #expect(await accumulator.errorDescription == nil)
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorAppliesMetadata() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append(
            [
                SessionStreamChunk(.start(.init(messageId: "message-1"))),
                SessionStreamChunk(.textStart(.init(id: "text-1"))),
                SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello")))
            ],
            messageMetadata: SessionStreamMessageMetadata(startedAt: "2026-06-24T00:00:00.000Z")
        )

        let message = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(message.metadata == .object([
            "startedAt": .string("2026-06-24T00:00:00.000Z")
        ]))
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorReemitsWhenMetadataArrivesAfterMessage() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello")))
        ])

        _ = try await recorder.waitForMessage { $0.text == "Hello" }

        await accumulator.append([], messageMetadata: SessionStreamMessageMetadata(startedAt: "2026-06-24T00:00:00.000Z"))

        let message = try await recorder.waitForMessage {
            $0.metadata == .object(["startedAt": .string("2026-06-24T00:00:00.000Z")])
        }
        #expect(message.text == "Hello")
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorSkipsUnknownChunksWithoutError() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.unknown(type: "future-chunk", rawValue: .object([
                "type": .string("future-chunk"),
                "payload": .object(["opaque": .bool(true)])
            ]))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hello")))
        ])

        let message = try await recorder.waitForMessage { $0.text == "Hello" }
        #expect(message.id == "message-1")
        #expect(await accumulator.errorDescription == nil)
        #expect(await recorder.errors.isEmpty)
        await accumulator.finish()
    }

    @Test
    func streamAccumulatorFinishCancelsCleanly() async throws {
        let recorder = StreamEmissionRecorder()
        let accumulator = recorder.makeAccumulator()

        await accumulator.append([
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "Hel")))
        ])

        _ = try await recorder.waitForMessage { $0.text == "Hel" }
        let messageCount = await recorder.messageCount

        await accumulator.finish()
        await accumulator.append([
            SessionStreamChunk(.textDelta(.init(id: "text-1", delta: "lo"))),
            SessionStreamChunk(.textEnd(.init(id: "text-1")))
        ])
        try await Task.sleep(for: .milliseconds(50))

        #expect(await recorder.messageCount == messageCount)
        #expect(await recorder.lastMessage?.text == "Hel")
    }

    @Test func clientStateMapsWebUsedFieldsToDomainState() {
        let state = ClientState(
            repoFullName: "benedelstein/cloude-code",
            status: .ready,
            sessionSetupRun: SessionSetupRun(
                id: "setup_1",
                status: .running,
                startedAt: "2026-06-13T00:00:00.000Z",
                tasks: [
                    .repository(RepositorySetupTask(status: .completed))
                ]
            ),
            agentSettings: .openaiCodex(AgentSettingsCodex(model: .gpt55, effort: .high, maxTokens: 4096)),
            pullRequest: .creating(PullRequestClientState.Creating()),
            pushedBranch: "codex/session-client-state",
            baseBranch: "main",
            todos: [
                SessionTodo(content: "Render messages", status: .inProgress)
            ],
            plan: SessionPlanMetadata(lastUpdated: "2026-06-13T00:01:00.000Z"),
            pendingUserMessage: PendingUserMessage(
                message: WireUIMessage(
                    id: "pending_1",
                    role: .user,
                    parts: [
                        .text(.init(text: "Hello"))
                    ]
                ),
                attachmentIds: []
            ),
            activeTurn: ActiveTurnState(userMessageId: "pending_1"),
            editorUrl: "https://example.com/editor",
            providerConnection: ProviderConnectionState(
                provider: .openaiCodex,
                connected: true,
                requiresReauth: false
            ),
            agentMode: .edit,
            lastError: nil,
            createdAt: "2026-06-13T00:00:00.000Z"
        )

        let clientState = SessionClientState(state)

        #expect(clientState.repoFullName == "benedelstein/cloude-code")
        #expect(clientState.status == .ready)
        #expect(clientState.sessionSetupRun?.status == .running)
        #expect(clientState.sessionSetupRun?.tasks.first?.id == .repository)
        #expect(clientState.sessionSetupRun?.tasks.first?.status == .completed)
        #expect(clientState.agentSettings.provider == .openaiCodex)
        #expect(clientState.agentSettings.model == "gpt-5.5")
        #expect(clientState.pullRequest == .creating)
        #expect(clientState.pushedBranch == "codex/session-client-state")
        #expect(clientState.baseBranch == "main")
        #expect(clientState.todos?.first?.status == "in_progress")
        #expect(clientState.plan?.lastUpdated == "2026-06-13T00:01:00.000Z")
        #expect(clientState.pendingUserMessage?.text == "Hello")
        #expect(clientState.activeTurnUserMessageId == "pending_1")
        #expect(clientState.editorURL == "https://example.com/editor")
        #expect(clientState.providerConnection?.connected == true)
        #expect(clientState.agentMode == .edit)
        #expect(clientState.createdAt == "2026-06-13T00:00:00.000Z")
    }

    @Test func startupScriptTaskMapsMetadataAndSkipReasonWithoutOutputText() throws {
        let state = ClientState(
            status: .preparing,
            sessionSetupRun: SessionSetupRun(
                id: "setup_1",
                status: .running,
                startedAt: "2026-06-13T00:00:00.000Z",
                tasks: [
                    .setupScript(StartupScriptSetupTask(
                        status: .skipped,
                        output: SessionSetupTaskOutput(
                            exitCode: 0,
                            truncated: true,
                            stdoutLength: 12_000,
                            stderrLength: 40,
                            stdout: "intentionally not mapped",
                            stderr: "intentionally not mapped"
                        ),
                        skipReason: .noScript(.init(
                            environmentId: "environment_1",
                            environmentName: "Development"
                        ))
                    ))
                ]
            ),
            agentSettings: .openaiCodex(.init(model: .gpt55, effort: .high, maxTokens: 4_096)),
            agentMode: .edit,
            createdAt: "2026-06-13T00:00:00.000Z"
        )

        let task = try #require(SessionClientState(state).sessionSetupRun?.tasks.first)

        #expect(task.id == .setupScript)
        #expect(task.status == .skipped)
        #expect(task.output?.exitCode == 0)
        #expect(task.output?.truncated == true)
        #expect(task.output?.stdoutLength == 12_000)
        #expect(task.output?.stderrLength == 40)
        #expect(task.skipReason == .noScript(
            environmentID: "environment_1",
            environmentName: "Development"
        ))
    }

    @Test func sessionSummaryIDsAreOpaqueStrings() {
        let summary = CoreAPI.SessionSummary(
            id: "session_custom_ID",
            repoId: 1,
            repoFullName: "ben/cloude-code",
            title: nil,
            archived: false,
            workingState: .idle,
            pushedBranch: nil,
            pullRequest: nil,
            createdAt: "2026-06-13T00:00:00.000Z",
            updatedAt: "2026-06-13T00:00:00.000Z",
            lastMessageAt: nil,
            lastAssistantMessageId: nil,
            hasUnread: false
        )

        #expect(summary.domainSummary.id == "session_custom_ID")
    }

    @Test func sessionSetupFailedStatusMapsToDomain() {
        #expect(SessionClientState.Status(rawValue: "setup_failed") == .setupFailed)
        #expect(SessionClientState.Status.setupFailed.rawValue == "setup_failed")

        var summary = CoreAPI.SessionSummary(
            id: "session-id",
            repoId: 1,
            repoFullName: "ben/cloude-code",
            archived: false,
            status: .setupFailed,
            workingState: .idle,
            createdAt: "2026-06-13T00:00:00.000Z",
            updatedAt: "2026-06-13T00:00:00.000Z",
            hasUnread: false
        )

        #expect(summary.domainSummary.status == .setupFailed)

        summary.status = .unknown("future-status")
        #expect(summary.domainSummary.status == .unknown("future-status"))
    }

    @Test func sessionSummaryMapsKnownAbsentAndUnknownProviders() {
        func summary(provider: CoreAPI.ProviderId?) -> CoreAPI.SessionSummary {
            CoreAPI.SessionSummary(
                id: "session-id",
                repoId: 1,
                repoFullName: "ben/cloude-code",
                provider: provider,
                archived: false,
                workingState: .idle,
                pushedBranch: nil,
                pullRequest: nil,
                createdAt: "2026-06-13T00:00:00.000Z",
                updatedAt: "2026-06-13T00:00:00.000Z",
                lastMessageAt: nil,
                lastAssistantMessageId: nil,
                hasUnread: false
            )
        }

        #expect(summary(provider: .claudeCode).domainSummary.provider == .claudeCode)
        #expect(summary(provider: nil).domainSummary.provider == nil)
        #expect(
            summary(provider: .unknown("future-provider")).domainSummary.provider
                == .unknown("future-provider")
        )
    }
}

private actor StreamEmissionRecorder {
    private(set) var statuses: [SessionMessageStreamStatus] = []
    private(set) var messages: [SessionMessage] = []
    private(set) var errors: [String] = []

    nonisolated func makeAccumulator(
        initialChunks: [SessionStreamChunk] = [],
        messageMetadata: SessionStreamMessageMetadata? = nil
    ) -> SessionMessageStreamAccumulator {
        SessionMessageStreamAccumulator(
            initialChunks: initialChunks,
            messageMetadata: messageMetadata,
            onStatus: { [weak self] status in
                Task {
                    await self?.record(status)
                }
            },
            onMessage: { [weak self] message in
                Task {
                    await self?.record(message)
                }
            }
        )
    }

    var messageCount: Int {
        messages.count
    }

    var lastMessage: SessionMessage? {
        messages.last
    }

    private func record(_ status: SessionMessageStreamStatus) {
        statuses.append(status)
        if let errorDescription = status.errorDescription {
            errors.append(errorDescription)
        }
    }

    private func record(_ message: SessionMessage) {
        messages.append(message)
    }

    func waitForMessage(
        where predicate: (SessionMessage) -> Bool
    ) async throws -> SessionMessage {
        for _ in 0..<100 {
            if let message = messages.last(where: predicate) {
                return message
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        Issue.record("Timed out waiting for streamed message")
        throw StreamEmissionTimeout()
    }

    func waitForMessageCount(_ count: Int) async throws -> [SessionMessage] {
        for _ in 0..<100 {
            if messages.count >= count {
                return messages
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        Issue.record("Timed out waiting for streamed message count")
        throw StreamEmissionTimeout()
    }
}

private struct StreamEmissionTimeout: Error {}
