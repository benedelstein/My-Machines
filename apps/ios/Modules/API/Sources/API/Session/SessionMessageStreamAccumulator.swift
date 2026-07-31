import Domain
import Foundation
import SwiftAISDK

/// Immediate status for the current streamed assistant message.
public struct SessionMessageStreamStatus: Sendable, Equatable {
    public let isActive: Bool
    public let chunkCount: Int
    public let messageMetadata: SessionStreamMessageMetadata?
    public let errorDescription: String?

    /// Creates a stream status value.
    ///
    /// - Parameters:
    ///   - isActive: Whether a streamed assistant response is active.
    ///   - chunkCount: Number of raw chunks received for the active stream.
    ///   - messageMetadata: Server-side metadata for the active stream.
    ///   - errorDescription: Latest stream reduction error description.
    public init(
        isActive: Bool = false,
        chunkCount: Int = 0,
        messageMetadata: SessionStreamMessageMetadata? = nil,
        errorDescription: String? = nil
    ) {
        self.isActive = isActive
        self.chunkCount = chunkCount
        self.messageMetadata = messageMetadata
        self.errorDescription = errorDescription
    }
}

/// Accumulates streamed assistant-message chunks through the Swift AI SDK reducer.
public actor SessionMessageStreamAccumulator {
    private enum EmissionPhase {
        case preparingBackfill
        case backfilling(remainingEmissions: Int)
        case live
    }

    public private(set) var chunks: [SessionStreamChunk] = []
    public private(set) var messageMetadata: SessionStreamMessageMetadata?
    public private(set) var message: SessionMessage?
    public private(set) var errorDescription: String?

    private let continuation: AsyncThrowingStream<SwiftAISDK.AnyUIMessageChunk, Error>.Continuation
    private let onStatus: @Sendable (SessionMessageStreamStatus) -> Void
    private let onMessage: @Sendable (SessionMessage) -> Void
    private var readTask: Task<Void, Never>?
    private var isFinished: Bool = false
    private var emissionPhase: EmissionPhase
    private var chunksQueuedDuringPreparation: [SessionStreamChunk] = []

    /// Current status value of the accumulator.
    public var status: SessionMessageStreamStatus {
        SessionMessageStreamStatus(
            isActive: !chunks.isEmpty,
            chunkCount: chunks.count,
            messageMetadata: messageMetadata,
            errorDescription: errorDescription
        )
    }

    /// Returns whether this accumulator has received stream chunks for an active assistant turn.
    public var isActive: Bool {
        status.isActive
    }

    /// Creates an accumulator that emits immediate status and SDK-reduced messages separately.
    ///
    /// - Parameters:
    ///   - initialChunks: Finite chunk history to reduce into one initial message before live emission.
    ///   - messageMetadata: Metadata associated with the active streamed message.
    ///   - onStatus: Called whenever active stream status changes.
    ///   - onMessage: Called whenever the SDK reducer emits the latest message.
    public init(
        initialChunks: [SessionStreamChunk] = [],
        messageMetadata: SessionStreamMessageMetadata? = nil,
        onStatus: @escaping @Sendable (SessionMessageStreamStatus) -> Void,
        onMessage: @escaping @Sendable (SessionMessage) -> Void
    ) {
        let streamPair = AsyncThrowingStream<SwiftAISDK.AnyUIMessageChunk, Error>.makeStream(
            of: SwiftAISDK.AnyUIMessageChunk.self
        )

        chunks = initialChunks
        self.messageMetadata = messageMetadata
        continuation = streamPair.continuation
        self.onStatus = onStatus
        self.onMessage = onMessage
        readTask = nil
        emissionPhase = initialChunks.isEmpty ? .live : .preparingBackfill

        let stream = streamPair.stream
        Task { [weak self] in
            await self?.startReadTask(stream: stream)
            await self?.prepareBackfill(initialChunks)
        }
        if !initialChunks.isEmpty {
            onStatus(SessionMessageStreamStatus(
                isActive: true,
                chunkCount: initialChunks.count,
                messageMetadata: messageMetadata
            ))
        }
    }

    deinit {
        continuation.finish()
        readTask?.cancel()
    }

    /// Appends newly received stream chunks and optional server-side stream metadata.
    ///
    /// - Parameters:
    ///   - newChunks: Chunks not previously yielded to this accumulator.
    ///   - newMessageMetadata: Metadata associated with the active streamed message.
    public func append(
        _ newChunks: [SessionStreamChunk],
        messageMetadata newMessageMetadata: SessionStreamMessageMetadata? = nil
    ) {
        guard !isFinished else {
            return
        }

        chunks.append(contentsOf: newChunks)
        let shouldReapplyMetadata = newMessageMetadata != nil && message != nil
        messageMetadata = newMessageMetadata ?? messageMetadata
        onStatus(status)

        if shouldReapplyMetadata, let message {
            if case .live = emissionPhase {
                publish(message)
            } else {
                store(message)
            }
        }

        if case .preparingBackfill = emissionPhase {
            Logger.debug("still preparing, queueing chunks...")
            chunksQueuedDuringPreparation.append(contentsOf: newChunks)
        } else {
            yield(newChunks)
        }
    }

    /// Finishes the underlying SDK stream and cancels the read task.
    public func finish() {
        guard !isFinished else {
            return
        }

        isFinished = true
        continuation.finish()
        readTask?.cancel()
        readTask = nil
    }

    private func startReadTask(
        stream: AsyncThrowingStream<SwiftAISDK.AnyUIMessageChunk, Error>
    ) {
        guard !isFinished, readTask == nil else {
            return
        }

        let sequence: SwiftAISDK.AsyncIterableStream<SwiftAISDK.UIMessage> = readUIMessageStream(
            message: nil,
            stream: stream
        ) { error in
            Task { [weak self] in
                await self?.recordError(error)
            }
        }

        readTask = Task { [weak self, sequence] in
            do {
                for try await sdkMessage in sequence {
                    await self?.record(sdkMessage)
                }
            } catch {
                guard !Task.isCancelled else {
                    return
                }
                await self?.recordError(error)
            }
        }
    }

    private func prepareBackfill(_ initialChunks: [SessionStreamChunk]) async {
        guard !initialChunks.isEmpty else {
            return
        }

        let emissionCount: Int
        do {
            emissionCount = try await SessionMessageStreamReader.emissionCount(from: initialChunks)
        } catch {
            recordError(error)
            emissionCount = 0
        }

        guard !isFinished else {
            return
        }
        emissionPhase = emissionCount == 0
            ? .live
            : .backfilling(remainingEmissions: emissionCount)
        yield(initialChunks)
        yield(chunksQueuedDuringPreparation)
        chunksQueuedDuringPreparation.removeAll()
    }

    private func yield(_ chunks: [SessionStreamChunk]) {
        for chunk in chunks {
            guard let sdkChunk = chunk.value.sdkChunk() else {
                continue
            }
            continuation.yield(sdkChunk)
        }
    }

    private func record(_ sdkMessage: SwiftAISDK.UIMessage) {
        guard !isFinished else {
            return
        }

        assert(!sdkMessage.id.isEmpty, "streaming message id is empty??")

        let newMessage = SessionMessage(aiSDKMessage: sdkMessage)
        switch emissionPhase {
        case .preparingBackfill:
            assertionFailure("Reducer emitted before backfill preparation completed")
            store(newMessage)
        case .backfilling(let remainingEmissions) where remainingEmissions > 1:
            emissionPhase = .backfilling(remainingEmissions: remainingEmissions - 1)
            store(newMessage)
        case .backfilling:
            emissionPhase = .live
            publish(newMessage)
        case .live:
            publish(newMessage)
        }
    }

    private func publish(_ newMessage: SessionMessage) {
        guard !isFinished else {
            return
        }

        let messageWithMetadata = store(newMessage)
        onStatus(status)
        onMessage(messageWithMetadata)
    }

    @discardableResult
    private func store(_ newMessage: SessionMessage) -> SessionMessage {
        let messageWithMetadata = newMessage.adding(messageMetadata: messageMetadata)
        message = messageWithMetadata
        errorDescription = nil
        return messageWithMetadata
    }

    private func recordError(_ error: any Error) {
        guard !isFinished else {
            return
        }

        errorDescription = error.localizedDescription
        onStatus(status)
    }
}

extension SessionMessage {
    func adding(messageMetadata: SessionStreamMessageMetadata?) -> SessionMessage {
        guard let messageMetadata else {
            return self
        }

        return SessionMessage(
            id: id,
            role: role,
            parts: parts,
            metadata: metadata.addingStartedAtIfNeeded(messageMetadata.startedAt)
        )
    }
}

extension Optional where Wrapped == Domain.JSONValue {
    func addingStartedAtIfNeeded(_ startedAt: String) -> Domain.JSONValue {
        let key = Domain.SessionMessageMetadata.startedAtKey
        guard case .object(var object) = self else {
            return .object([key: .string(startedAt)])
        }
        if object[key] == nil {
            object[key] = .string(startedAt)
        }
        return .object(object)
    }
}
