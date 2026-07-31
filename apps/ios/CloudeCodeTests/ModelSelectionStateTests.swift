import API
import CoreAPI
import Domain
import Foundation
import Testing
@testable import CloudeCode

@MainActor
struct ModelSelectionTests {
    @Test func resolvedKeepsValidCandidateAndEffort() {
        let provider = makeProvider()
        let catalog = ModelsResponse(providers: [provider])
        let candidate = ModelSelection(
            providerId: provider.providerId,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: "low",
            effortDisplayName: "Low"
        )

        let resolved = ModelSelection.resolved(from: candidate, in: catalog)

        #expect(resolved?.modelId == "gpt-5.5")
        #expect(resolved?.effortId == "low")
    }

    @Test func resolvedFallsBackToDefaultWhenModelMissing() {
        let provider = makeProvider()
        let catalog = ModelsResponse(providers: [provider])
        let candidate = ModelSelection(
            providerId: provider.providerId,
            modelId: "gpt-4-removed",
            displayName: "GPT-4",
            effortId: nil,
            effortDisplayName: nil
        )

        let resolved = ModelSelection.resolved(from: candidate, in: catalog)

        #expect(resolved?.modelId == provider.defaultModel)
        #expect(resolved?.effortId == provider.defaultEffort)
    }

    @Test func resolvedFallsBackWhenProviderDisconnected() {
        let disconnected = makeProvider(connected: false)
        let fallback = makeProvider(providerId: .claudeCode)
        let catalog = ModelsResponse(providers: [disconnected, fallback])
        let candidate = ModelSelection(
            providerId: disconnected.providerId,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: nil,
            effortDisplayName: nil
        )

        let resolved = ModelSelection.resolved(from: candidate, in: catalog)

        #expect(resolved?.providerId == fallback.providerId)
    }

    @Test func resolvedIsNilWhenNoProviderSelectable() {
        let catalog = ModelsResponse(providers: [makeProvider(connected: false)])

        #expect(ModelSelection.resolved(from: nil, in: catalog) == nil)
    }

    @Test func selectingModelPreservesEffortWithinProvider() {
        let provider = makeProvider()
        let current = ModelSelection.selecting(
            provider: provider,
            model: provider.models[0],
            preservingEffortFrom: nil
        )
        let withLowEffort = ModelSelection.selecting(
            provider: provider,
            effort: provider.efforts[1],
            for: current
        )

        let reselected = ModelSelection.selecting(
            provider: provider,
            model: provider.models[1],
            preservingEffortFrom: withLowEffort
        )

        #expect(reselected.modelId == provider.models[1].id)
        #expect(reselected.effortId == "low")
    }

    @Test func selectingEffortRejectsMismatchedProvider() {
        let provider = makeProvider()
        let other = makeProvider(providerId: .claudeCode)
        let current = ModelSelection.selecting(
            provider: other,
            model: other.models[0],
            preservingEffortFrom: nil
        )

        let selection = ModelSelection.selecting(
            provider: provider,
            effort: provider.efforts[0],
            for: current
        )

        #expect(selection == nil)
    }

    @Test func isValidRejectsModelsOutsideCatalog() {
        let provider = makeProvider()
        let catalog = ModelsResponse(providers: [provider])
        let unknownModel = ModelSelection(
            providerId: provider.providerId,
            modelId: "not-in-catalog",
            displayName: "Unknown",
            effortId: nil,
            effortDisplayName: nil
        )
        let unknownEffort = ModelSelection(
            providerId: provider.providerId,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: "not-an-effort",
            effortDisplayName: nil
        )
        let valid = ModelSelection(
            providerId: provider.providerId,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: "high",
            effortDisplayName: "High"
        )

        #expect(!unknownModel.isValid(in: catalog))
        #expect(!unknownEffort.isValid(in: catalog))
        #expect(valid.isValid(in: catalog))
        #expect(!valid.isValid(in: nil))
    }

    @Test func isValidRejectsDisconnectedProvider() {
        let provider = makeProvider(connected: false)
        let catalog = ModelsResponse(providers: [provider])
        let selection = ModelSelection(
            providerId: provider.providerId,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: nil,
            effortDisplayName: nil
        )

        #expect(!selection.isValid(in: catalog))
    }

    @Test func matchesNormalizesEmptyEffort() {
        let selection = ModelSelection(
            providerId: .openaiCodex,
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            effortId: nil,
            effortDisplayName: nil
        )

        #expect(selection.matches(SessionClientState.AgentSettings(
            provider: .openaiCodex,
            model: "gpt-5.5",
            effort: "",
            maxTokens: 4_096
        )))
        #expect(!selection.matches(SessionClientState.AgentSettings(
            provider: .openaiCodex,
            model: "gpt-5.5",
            effort: "high",
            maxTokens: 4_096
        )))
        #expect(!selection.matches(SessionClientState.AgentSettings(
            provider: .claudeCode,
            model: "gpt-5.5",
            effort: "",
            maxTokens: 4_096
        )))
    }
}

@MainActor
struct ModelCatalogStoreTests {
    @Test func loadsOnceAndCachesInMemory() async {
        let api = CountingModelsAPI(
            response: ModelsResponse(providers: [makeProvider()])
        )
        let store = ModelCatalogStore(modelsAPI: api)

        await store.load()
        await store.load()

        #expect(api.callCount == 1)
        #expect(store.catalog?.providers.count == 1)
        #expect(store.errorMessage == nil)
    }

    @Test func retriesAfterFailure() async {
        let api = CountingModelsAPI(
            response: ModelsResponse(providers: [makeProvider()]),
            failuresBeforeSuccess: 1
        )
        let store = ModelCatalogStore(modelsAPI: api)

        await store.load()
        #expect(store.catalog == nil)
        #expect(store.errorMessage != nil)

        await store.load()
        #expect(api.callCount == 2)
        #expect(store.catalog != nil)
        #expect(store.errorMessage == nil)
    }

    @Test func sortsSelectableProvidersFirst() async {
        let disconnected = makeProvider(providerId: .openaiCodex, connected: false)
        let connected = makeProvider(providerId: .claudeCode)
        let api = CountingModelsAPI(
            response: ModelsResponse(providers: [disconnected, connected])
        )
        let store = ModelCatalogStore(modelsAPI: api)

        await store.load()

        #expect(store.catalog?.providers.first?.providerId == connected.providerId)
    }

    @Test func resetClearsCachedCatalog() async {
        let api = CountingModelsAPI(
            response: ModelsResponse(providers: [makeProvider()])
        )
        let store = ModelCatalogStore(modelsAPI: api)
        await store.load()

        store.reset()

        #expect(store.catalog == nil)
        #expect(store.errorMessage == nil)
        #expect(!store.isLoading)
    }
}

extension AgentSessionTranscriptStateTests {
    @Test func providerAuthRequirementBlocksExistingSessionSubmission() {
        let viewModel = makeViewModel(provider: .claudeCode)
        var state = liveState(provider: .claudeCode)
        state.providerConnection = .init(
            provider: ProviderId.claudeCode.rawValue,
            connected: false,
            requiresReauth: true
        )
        viewModel.applyLiveState(state)
        viewModel.connectionState = .connected
        viewModel.draftText = "Continue"

        #expect(!viewModel.canSubmitDraft)

        state.providerConnection = .init(
            provider: ProviderId.claudeCode.rawValue,
            connected: true,
            requiresReauth: false
        )
        viewModel.applyLiveState(state)

        #expect(viewModel.canSubmitDraft)
    }

    @Test func existingSessionReconnectPreservesServerModelSelection() async {
        let modelsAPI = CountingModelsAPI(
            response: ModelsResponse(providers: [makeProvider()])
        )
        let viewModel = makeViewModel(
            provider: .openaiCodex,
            modelsAPI: modelsAPI
        )
        viewModel.applyLiveState(liveState(provider: .openaiCodex))
        await viewModel.modelCatalogStore.load()

        viewModel.selectDefaultModel(for: .openaiCodex)

        #expect(viewModel.localModelSelection == nil)
        #expect(viewModel.modelSelection?.modelId == "model")
    }
}

@MainActor
private final class CountingModelsAPI: ModelsAPIProviding {
    private let response: ModelsResponse
    private var failuresBeforeSuccess: Int
    private(set) var callCount: Int = 0

    init(response: ModelsResponse, failuresBeforeSuccess: Int = 0) {
        self.response = response
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func models() async throws -> ModelsResponse {
        callCount += 1
        if failuresBeforeSuccess > 0 {
            failuresBeforeSuccess -= 1
            throw URLError(.badServerResponse)
        }
        return response
    }
}

private func makeProvider(
    providerId: ProviderId = .openaiCodex,
    connected: Bool = true
) -> ProviderCatalogEntry {
    ProviderCatalogEntry(
        providerId: providerId,
        providerName: "Provider \(providerId.rawValue)",
        connected: connected,
        requiresReauth: false,
        defaultModel: "gpt-5.5",
        defaultEffort: "high",
        authMethods: [],
        models: [
            ProviderCatalogModel(
                id: "gpt-5.5",
                displayName: "GPT-5.5",
                isDefault: true,
                selectable: true
            ),
            ProviderCatalogModel(
                id: "gpt-5.5-mini",
                displayName: "GPT-5.5 Mini",
                isDefault: false,
                selectable: true
            )
        ],
        efforts: [
            ProviderCatalogEffort(
                id: "high",
                displayName: "High",
                isDefault: true,
                selectable: true
            ),
            ProviderCatalogEffort(
                id: "low",
                displayName: "Low",
                isDefault: false,
                selectable: true
            )
        ]
    )
}
