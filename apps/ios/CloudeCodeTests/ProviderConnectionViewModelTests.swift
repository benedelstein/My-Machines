import API
import CoreAPI
import Domain
import Foundation
import Testing
@testable import CloudeCode

@MainActor
struct ClaudeProviderConnectionViewModelTests {
    @Test func opensAuthorizationAndExchangesPastedCode() async throws {
        let authAPI = ProviderAuthAPISpy()
        let modelsAPI = ProviderConnectionModelsAPISpy()
        let viewModel = ClaudeProviderConnectionViewModel(
            context: providerContext(providerId: .claudeCode, sessionId: "session-1"),
            api: authAPI,
            modelCatalogStore: ModelCatalogStore(modelsAPI: modelsAPI)
        )

        viewModel.beginAuthorization()
        try await waitUntil { viewModel.phase == .awaitingCode }

        #expect(viewModel.externalAuthorizationURL?.absoluteString == "https://claude.ai/oauth/authorize")

        viewModel.didOpenExternalAuthorization()
        viewModel.code = "  claude-code  "
        viewModel.submitCode()
        try await waitUntil { viewModel.isConnected }

        #expect(authAPI.claudeExchange?.code == "claude-code")
        #expect(authAPI.claudeExchange?.state == "claude-state")
        #expect(authAPI.claudeExchange?.sessionId == "session-1")
        #expect(modelsAPI.callCount == 1)
    }
}

@MainActor
struct OpenAIProviderConnectionViewModelTests {
    @Test func preparesCodeBeforeOpeningOrPolling() async throws {
        let authAPI = ProviderAuthAPISpy(openAIStatuses: [.completed])
        let viewModel = makeViewModel(authAPI: authAPI)

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }

        #expect(viewModel.phase == .codeReady(openAIAuthorization))
        #expect(viewModel.authorization?.userCode == "ABCD-EFGH")
        #expect(authAPI.openAIPollCount == 0)
    }

    @Test func startsPollingOnlyAfterAuthorizationPageOpens() async throws {
        let authAPI = ProviderAuthAPISpy(openAIStatuses: [.pending, .completed])
        let modelsAPI = ProviderConnectionModelsAPISpy()
        let viewModel = makeViewModel(
            sessionId: "session-2",
            authAPI: authAPI,
            modelsAPI: modelsAPI
        )

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }
        viewModel.didOpenAuthorization()
        try await waitUntil { viewModel.isConnected }

        #expect(authAPI.openAIPollCount == 2)
        #expect(authAPI.lastOpenAIAttemptId == "attempt-1")
        #expect(authAPI.lastOpenAISessionId == "session-2")
        #expect(modelsAPI.callCount == 1)
    }

    @Test func keepsPollingThroughTransientNetworkErrors() async throws {
        let authAPI = ProviderAuthAPISpy(openAIPollResults: [
            .failure(URLError(.networkConnectionLost)),
            .failure(URLError(.cancelled)),
            .success(.completed)
        ])
        let viewModel = makeViewModel(authAPI: authAPI)

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }
        viewModel.didOpenAuthorization()
        try await waitUntil { viewModel.isConnected }

        #expect(authAPI.openAIPollCount == 3)
        #expect(viewModel.errorMessage == nil)
    }

    @Test func pollsImmediatelyWhenSceneBecomesActive() async throws {
        let authAPI = ProviderAuthAPISpy(openAIStatuses: [.completed])
        // A long interval keeps the initial loop asleep so only the
        // foreground-triggered immediate poll can complete the connection.
        let viewModel = makeViewModel(authAPI: authAPI, pollInterval: .seconds(60))

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }
        viewModel.didOpenAuthorization()
        #expect(authAPI.openAIPollCount == 0)

        viewModel.sceneDidBecomeActive()
        try await waitUntil { viewModel.isConnected }

        #expect(authAPI.openAIPollCount == 1)
    }

    @Test func surfacesNonTransientPollErrors() async throws {
        let authAPI = ProviderAuthAPISpy(openAIPollResults: [
            .failure(URLError(.badServerResponse))
        ])
        let viewModel = makeViewModel(authAPI: authAPI)

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }
        viewModel.didOpenAuthorization()
        try await waitUntil { viewModel.errorMessage != nil }

        #expect(viewModel.phase == .ready)
        #expect(!viewModel.isConnected)
    }

    @Test func expiredAuthorizationReturnsToReadyWithError() async throws {
        let authAPI = ProviderAuthAPISpy(openAIStatuses: [.expired])
        let viewModel = makeViewModel(authAPI: authAPI)

        viewModel.load()
        try await waitUntil { viewModel.authorization != nil }
        viewModel.didOpenAuthorization()
        try await waitUntil { viewModel.errorMessage != nil }

        #expect(viewModel.phase == .ready)
        #expect(viewModel.errorMessage == "The authorization code expired. Try connecting again.")
        #expect(!viewModel.isConnected)
    }

    private func makeViewModel(
        sessionId: String? = nil,
        authAPI: ProviderAuthAPISpy,
        modelsAPI: ProviderConnectionModelsAPISpy? = nil,
        pollInterval: Duration = .milliseconds(1)
    ) -> OpenAIProviderConnectionViewModel {
        let modelsAPI = modelsAPI ?? ProviderConnectionModelsAPISpy()
        return OpenAIProviderConnectionViewModel(
            context: providerContext(providerId: .openaiCodex, sessionId: sessionId),
            api: authAPI,
            modelCatalogStore: ModelCatalogStore(modelsAPI: modelsAPI),
            pollIntervalOverride: pollInterval
        )
    }
}

@MainActor
private func providerContext(providerId: ProviderId, sessionId: String?) -> ProviderConnectionContext {
    ProviderConnectionContext(
        providerId: providerId,
        providerName: providerId == .claudeCode ? "Claude" : "OpenAI Codex",
        requiresReauth: false,
        sessionId: sessionId
    )
}

@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
    for _ in 0..<100 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw ProviderConnectionTestError.timedOut
}

private let openAIAuthorization = OpenAIDeviceAuthorization(
    attemptId: "attempt-1",
    verificationURL: "https://auth.openai.com/device",
    userCode: "ABCD-EFGH",
    intervalSeconds: 5
)

@MainActor
private final class ProviderAuthAPISpy: ProviderAuthAPIProviding {
    struct ClaudeExchange: Equatable {
        let code: String
        let state: String
        let sessionId: String?
    }

    private var openAIPollResults: [Result<OpenAIDeviceAuthorizationStatus, any Error>]
    private(set) var claudeExchange: ClaudeExchange?
    private(set) var openAIPollCount = 0
    private(set) var lastOpenAIAttemptId: String?
    private(set) var lastOpenAISessionId: String?

    init(openAIStatuses: [OpenAIDeviceAuthorizationStatus] = []) {
        self.openAIPollResults = openAIStatuses.map { .success($0) }
    }

    init(openAIPollResults: [Result<OpenAIDeviceAuthorizationStatus, any Error>]) {
        self.openAIPollResults = openAIPollResults
    }

    func claudeAuthorization() async throws -> ProviderAuthorization {
        ProviderAuthorization(
            url: "https://claude.ai/oauth/authorize",
            state: "claude-state"
        )
    }

    func exchangeClaudeCode(code: String, state: String, sessionId: String?) async throws {
        claudeExchange = ClaudeExchange(code: code, state: state, sessionId: sessionId)
    }

    func startOpenAIDeviceAuthorization() async throws -> OpenAIDeviceAuthorization {
        openAIAuthorization
    }

    func pollOpenAIDeviceAuthorization(
        attemptId: String,
        sessionId: String?
    ) async throws -> OpenAIDeviceAuthorizationStatus {
        openAIPollCount += 1
        lastOpenAIAttemptId = attemptId
        lastOpenAISessionId = sessionId
        guard !openAIPollResults.isEmpty else { return .pending }
        return try openAIPollResults.removeFirst().get()
    }

    func disconnectClaude() async throws {}

    func disconnectOpenAI() async throws {}
}

@MainActor
private final class ProviderConnectionModelsAPISpy: ModelsAPIProviding {
    private(set) var callCount = 0

    func models() async throws -> ModelsResponse {
        callCount += 1
        return ModelsResponse(providers: [])
    }
}

private enum ProviderConnectionTestError: Error {
    case timedOut
}
