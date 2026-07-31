import API
import Domain
import Foundation
import Observation

/// State and effects for the Claude authorization-code connection flow.
@MainActor
@Observable
final class ClaudeProviderConnectionViewModel {
    enum Phase: Equatable {
        case ready
        case preparing
        case awaitingCode
        case submitting
        case connected
    }

    let context: ProviderConnectionContext
    private let api: any ProviderAuthAPIProviding
    private let modelCatalogStore: ModelCatalogStore
    private var authorizationState: String?
    private var authorizationURL: URL?
    @ObservationIgnored private var connectionTask: Task<Void, Never>?

    private(set) var phase: Phase = .ready
    private(set) var externalAuthorizationURL: URL?
    var code: String = ""
    var errorMessage: String?

    var isConnected: Bool {
        phase == .connected
    }

    var isWorking: Bool {
        phase == .preparing || phase == .submitting
    }

    var canSubmitCode: Bool {
        !isWorking && !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(
        context: ProviderConnectionContext,
        api: any ProviderAuthAPIProviding,
        modelCatalogStore: ModelCatalogStore
    ) {
        self.context = context
        self.api = api
        self.modelCatalogStore = modelCatalogStore
    }

    /// Requests a Claude authorization URL and opens it externally.
    func beginAuthorization() {
        guard connectionTask == nil else { return }
        errorMessage = nil
        phase = .preparing

        connectionTask = Task { [weak self] in
            guard let self else { return }
            defer { connectionTask = nil }

            do {
                let authorization = try await api.claudeAuthorization()
                try Task.checkCancellation()
                guard let url = URL(string: authorization.url) else {
                    throw ClaudeProviderConnectionError.invalidAuthorizationURL
                }

                authorizationState = authorization.state
                authorizationURL = url
                externalAuthorizationURL = url
                phase = .awaitingCode
            } catch is CancellationError {
                return
            } catch {
                phase = .ready
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Reopens the previously prepared Claude authorization URL.
    func reopenAuthorization() {
        guard let authorizationURL, !isWorking else { return }
        externalAuthorizationURL = authorizationURL
    }

    /// Clears the one-shot external URL after the view opens it.
    func didOpenExternalAuthorization() {
        externalAuthorizationURL = nil
    }

    /// Exchanges the pasted Claude code and refreshes the model catalog.
    func submitCode() {
        let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard connectionTask == nil,
              let authorizationState,
              !trimmedCode.isEmpty else {
            return
        }

        errorMessage = nil
        phase = .submitting
        connectionTask = Task { [weak self] in
            guard let self else { return }
            defer { connectionTask = nil }

            do {
                try await api.exchangeClaudeCode(
                    code: trimmedCode,
                    state: authorizationState,
                    sessionId: context.sessionId
                )
                try Task.checkCancellation()
                await finishConnection()
            } catch is CancellationError {
                return
            } catch {
                phase = .awaitingCode
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Cancels in-flight work when the connection sheet disappears.
    func unload() {
        connectionTask?.cancel()
        connectionTask = nil
        externalAuthorizationURL = nil
    }

    private func finishConnection() async {
        modelCatalogStore.reset()
        await modelCatalogStore.load()
        guard !Task.isCancelled else { return }
        phase = .connected
    }
}

private enum ClaudeProviderConnectionError: LocalizedError {
    case invalidAuthorizationURL

    var errorDescription: String? {
        "Claude returned an invalid authorization URL."
    }
}
