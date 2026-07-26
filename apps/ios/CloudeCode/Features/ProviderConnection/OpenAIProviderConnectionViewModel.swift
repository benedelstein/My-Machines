import API
import Domain
import Foundation
import Observation

/// State and effects for the OpenAI Codex device-code connection flow.
@MainActor
@Observable
final class OpenAIProviderConnectionViewModel {
    enum Phase: Equatable {
        case ready
        case preparing
        case codeReady(OpenAIDeviceAuthorization)
        case waiting(OpenAIDeviceAuthorization)
        case connected
    }

    let context: ProviderConnectionContext
    private let api: any ProviderAuthAPIProviding
    private let modelCatalogStore: ModelCatalogStore
    private let pollIntervalOverride: Duration?
    @ObservationIgnored private var preparationTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    private(set) var phase: Phase = .ready
    var errorMessage: String?

    var authorization: OpenAIDeviceAuthorization? {
        switch phase {
        case .codeReady(let authorization), .waiting(let authorization):
            authorization
        case .ready, .preparing, .connected:
            nil
        }
    }

    var isPreparing: Bool {
        phase == .preparing
    }

    var isWaiting: Bool {
        if case .waiting = phase {
            return true
        }
        return false
    }

    var isConnected: Bool {
        phase == .connected
    }

    init(
        context: ProviderConnectionContext,
        api: any ProviderAuthAPIProviding,
        modelCatalogStore: ModelCatalogStore,
        pollIntervalOverride: Duration? = nil
    ) {
        self.context = context
        self.api = api
        self.modelCatalogStore = modelCatalogStore
        self.pollIntervalOverride = pollIntervalOverride
    }

    /// Loads the device code shown when the connection screen appears.
    func load() {
        guard phase == .ready, preparationTask == nil, pollTask == nil else { return }
        Logger.info("OpenAI device authorization load started")
        errorMessage = nil
        phase = .preparing

        preparationTask = Task { [weak self] in
            guard let self else { return }
            defer { preparationTask = nil }

            do {
                let authorization = try await api.startOpenAIDeviceAuthorization()
                try Task.checkCancellation()
                guard URL(string: authorization.verificationURL) != nil else {
                    throw OpenAIProviderConnectionError.invalidAuthorizationURL
                }
                Logger.info("OpenAI device authorization load completed")
                phase = .codeReady(authorization)
            } catch is CancellationError {
                Logger.info("OpenAI device authorization load cancelled")
                return
            } catch {
                Logger.error("OpenAI device authorization load failed", error)
                phase = .ready
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Starts polling after the user opens the prepared authorization URL.
    func didOpenAuthorization() {
        guard case .codeReady(let authorization) = phase else { return }
        errorMessage = nil
        phase = .waiting(authorization)
        beginPolling(authorization)
    }

    /// Restarts polling with an immediate attempt when the app returns to the
    /// foreground, where any request in flight during suspension was likely
    /// killed by the system.
    func sceneDidBecomeActive() {
        guard case .waiting(let authorization) = phase else { return }
        Logger.info("OpenAI device authorization polling resumed on foreground")
        beginPolling(authorization, pollImmediately: true)
    }

    /// Cancels in-flight requests and polling when the sheet disappears.
    func unload() {
        preparationTask?.cancel()
        preparationTask = nil
        pollTask?.cancel()
        pollTask = nil
    }

    private func beginPolling(_ authorization: OpenAIDeviceAuthorization, pollImmediately: Bool = false) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            await runPollLoop(authorization, pollImmediately: pollImmediately)
            // A replaced task is cancelled before the new one is stored; only
            // the current task may clear the reference.
            if !Task.isCancelled {
                pollTask = nil
            }
        }
    }

    private func runPollLoop(_ authorization: OpenAIDeviceAuthorization, pollImmediately: Bool) async {
        let interval = pollIntervalOverride
            ?? .seconds(max(authorization.intervalSeconds, 1))
        var shouldSleep = !pollImmediately

        do {
            while !Task.isCancelled {
                if shouldSleep {
                    try await Task.sleep(for: interval)
                }
                shouldSleep = true

                do {
                    let status = try await api.pollOpenAIDeviceAuthorization(
                        attemptId: authorization.attemptId,
                        sessionId: context.sessionId
                    )
                    try Task.checkCancellation()

                    guard try await handle(status) else { return }
                } catch let error where Self.isTransientPollError(error) && !Task.isCancelled {
                    // Polling spans a trip to ChatGPT, so suspension routinely
                    // kills a request mid-flight. The attempt stays valid
                    // server-side; keep waiting instead of surfacing the error.
                    Logger.info("OpenAI device authorization poll retrying after transient error: \(error.localizedDescription)")
                }
            }
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            Logger.error("OpenAI device authorization poll failed", error)
            phase = .ready
            errorMessage = error.localizedDescription
        }
    }

    private static func isTransientPollError(_ error: any Error) -> Bool {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled,
                 .timedOut,
                 .networkConnectionLost,
                 .notConnectedToInternet,
                 .cannotConnectToHost,
                 .cannotFindHost,
                 .dnsLookupFailed,
                 .dataNotAllowed:
                return true
            default:
                return false
            }
        }
        if case APIError.httpError(let statusCode, _, _) = error {
            return statusCode >= 500 || statusCode == 429
        }
        return false
    }

    private func handle(_ status: OpenAIDeviceAuthorizationStatus) async throws -> Bool {
        switch status {
        case .pending:
            return true
        case .completed:
            await finishConnection()
            return false
        case .expired:
            phase = .ready
            errorMessage = OpenAIProviderConnectionError.authorizationExpired.localizedDescription
            return false
        case .unknown(let value):
            throw OpenAIProviderConnectionError.unknownAuthorizationStatus(value)
        }
    }

    private func finishConnection() async {
        modelCatalogStore.reset()
        await modelCatalogStore.load()
        guard !Task.isCancelled else { return }
        phase = .connected
    }
}

private enum OpenAIProviderConnectionError: LocalizedError {
    case invalidAuthorizationURL
    case authorizationExpired
    case unknownAuthorizationStatus(String)

    var errorDescription: String? {
        switch self {
        case .invalidAuthorizationURL:
            "OpenAI returned an invalid authorization URL."
        case .authorizationExpired:
            "The authorization code expired. Try connecting again."
        case .unknownAuthorizationStatus(let status):
            "OpenAI returned an unknown authorization status: \(status)."
        }
    }
}
