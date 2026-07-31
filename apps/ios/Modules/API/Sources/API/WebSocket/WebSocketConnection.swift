import Domain
import Foundation

/// Lifecycle of a `WebSocketConnection`.
public enum WebSocketConnectionState: Sendable, Equatable {
    case connecting
    case connected
    case disconnected
}

/// Raw transport events emitted by `WebSocketConnection`.
public enum WebSocketTransportEvent: Sendable {
    case stateChanged(WebSocketConnectionState)
    case message(Data)
}

/// Reconnecting WebSocket transport over `URLSessionWebSocketTask`.
///
/// Owns the receive loop and reconnect loop. The upgrade URL is re-resolved
/// on every attempt so short-lived `?token=` credentials are refreshed.
/// Frames are surfaced raw; typed decoding lives in the protocol-specific sockets.
/// `events` is a single-consumer stream.
public actor WebSocketConnection {
    public nonisolated let events: AsyncStream<WebSocketTransportEvent>

    private let makeURL: @Sendable () async throws -> URL
    private let sessionDelegate: WebSocketSessionDelegate
    private let urlSession: URLSession
    private let continuation: AsyncStream<WebSocketTransportEvent>.Continuation

    private var socketTask: URLSessionWebSocketTask?
    private var runTask: Task<Void, Never>?
    private var retryCount: Int = 0
    private var isStopped: Bool = true

    private static let maxRetryDelaySeconds: Double = 30

    /// Creates a reconnecting WebSocket connection.
    public init(
        urlSessionConfiguration: URLSessionConfiguration = .default,
        makeURL: @escaping @Sendable () async throws -> URL
    ) {
        let sessionDelegate = WebSocketSessionDelegate()
        self.sessionDelegate = sessionDelegate
        self.urlSession = URLSession(
            configuration: urlSessionConfiguration,
            delegate: sessionDelegate,
            delegateQueue: nil
        )
        self.makeURL = makeURL
        (events, continuation) = AsyncStream.makeStream()
    }

    /// Starts the connect/receive/reconnect loop. No-op while already running.
    public func connect() {
        // `isStopped` is false exactly while `runTask` is alive: the two are
        // only flipped together (here and in `disconnect`), and `run()` only
        // exits via `disconnect`. So this guard prevents a double-start.
        guard isStopped else { return }
        isStopped = false
        retryCount = 0
        runTask = Task { await run() }
    }

    /// Stops reconnecting and closes the current socket.
    public func disconnect() {
        isStopped = true
        runTask?.cancel()
        runTask = nil
        socketTask?.cancel(with: .normalClosure, reason: nil)
        socketTask = nil
        continuation.yield(.stateChanged(.disconnected))
    }

    public func send(text: String) async throws {
        guard let socketTask else {
            throw APIError.webSocketNotConnected
        }
        try await socketTask.send(.string(text))
    }

    private func run() async {
        while !Task.isCancelled, !isStopped {
            continuation.yield(.stateChanged(.connecting))
            do {
                let url = try await makeURL()
                Logger.debug("websocket connecting to", url.sanitizedWebSocketLogString)
                let task = urlSession.webSocketTask(with: url)
                socketTask = task
                try await awaitOpen(on: task)
                guard !Task.isCancelled, !isStopped else { return }
                retryCount = 0
                Logger.debug("websocket connected")
                continuation.yield(.stateChanged(.connected))
                try await receiveLoop(on: task)
            } catch {
                // Fall through to backoff; covers failed upgrades and drops.
                Logger.warning("WebSocket connection lost:", error)
            }
            socketTask?.cancel(with: .normalClosure, reason: nil)
            Logger.debug("websocket closed normally")
            socketTask = nil
            guard !Task.isCancelled, !isStopped else { return }
            continuation.yield(.stateChanged(.disconnected))
            await backoff()
        }
    }

    private func awaitOpen(on task: URLSessionWebSocketTask) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                sessionDelegate.registerOpenContinuation(continuation, for: task)
                task.resume()
                Logger.debug("websocket task resumed")
            }
        } onCancel: {
            sessionDelegate.finishOpenWaiter(for: task, with: .failure(CancellationError()))
        }
    }

    private func receiveLoop(on task: URLSessionWebSocketTask) async throws {
        while !Task.isCancelled {
            let message = try await task.receive()
            guard !Task.isCancelled, !isStopped else { return }
            switch message {
            case .string(let text):
                continuation.yield(.message(Data(text.utf8)))
            case .data(let data):
                continuation.yield(.message(data))
            @unknown default:
                break
            }
        }
    }

    private func backoff() async {
        let baseDelay = min(pow(2, Double(retryCount)), Self.maxRetryDelaySeconds)
        let delay = Double.random(in: (baseDelay / 2)...baseDelay)
        retryCount += 1
        try? await Task.sleep(for: .seconds(delay))
    }
}

private final class WebSocketSessionDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock: NSLock = NSLock()
    private var openContinuations: [ObjectIdentifier: CheckedContinuation<Void, any Error>] = [:]

    func registerOpenContinuation(
        _ continuation: CheckedContinuation<Void, any Error>,
        for task: URLSessionWebSocketTask
    ) {
        lock.withLock {
            openContinuations[ObjectIdentifier(task)] = continuation
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        finishOpenWaiter(for: webSocketTask, with: .success(()))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        guard let webSocketTask = task as? URLSessionWebSocketTask else { return }
        finishOpenWaiter(
            for: webSocketTask,
            with: .failure(error ?? URLError(.networkConnectionLost))
        )
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        finishOpenWaiter(for: webSocketTask, with: .failure(URLError(.networkConnectionLost)))
    }

    func finishOpenWaiter(
        for task: URLSessionWebSocketTask,
        with result: Result<Void, any Error>
    ) {
        let continuation = lock.withLock {
            openContinuations.removeValue(forKey: ObjectIdentifier(task))
        }
        continuation?.resume(with: result)
    }
}

private extension URL {
    var sanitizedWebSocketLogString: String {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false) else {
            return absoluteString
        }
        components.queryItems = components.queryItems?.map { item in
            item.name == "token" ? URLQueryItem(name: item.name, value: "<redacted>") : item
        }
        return components.string ?? absoluteString
    }
}

enum WebSocketURLBuilder {
    /// Converts the HTTP API base URL into a `ws(s)` upgrade URL with the
    /// short-lived token in the query string, matching the web clients.
    static func url(baseURL: URL, path: String, token: String) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw APIError.invalidURL
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = components.path
            .appending("/")
            .appending(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else {
            throw APIError.invalidURL
        }
        return url
    }
}
