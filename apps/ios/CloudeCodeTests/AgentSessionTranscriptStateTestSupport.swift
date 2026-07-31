import CoreAPI
import Domain
import Entities
@testable import CloudeCode

extension AgentSessionTranscriptStateTests {
    func makeSession(
        provider: AgentProviderID?,
        title: String? = nil,
        repoFullName: String = "octo/repo",
        status: Domain.SessionStatus? = nil,
        workingState: String = "idle",
        pushedBranch: String? = nil,
        pullRequest: Domain.SessionSummary.PullRequest? = nil
    ) -> SessionSummaryModel {
        SessionSummaryModel(SessionSummary(
            id: "session-1",
            repoId: 1,
            repoFullName: repoFullName,
            provider: provider,
            title: title,
            archived: false,
            status: status,
            workingState: workingState,
            pushedBranch: pushedBranch,
            pullRequest: pullRequest,
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
