import API
import Combine
import Domain
import Entities
import Foundation

extension AgentSessionViewModel {
    func upsert(_ message: SessionMessage) {
        upsertTranscriptMessage(
            rowID: transcriptRowID(for: message),
            message: message,
            isStreaming: false
        )
    }

    func applyAgentFinish(_ message: SessionMessage) {
        messageThrottler?.flush()
        let rowID = transcriptRowID(for: message)
        upsertTranscriptMessage(rowID: rowID, message: message, isStreaming: false)
        streamingTranscriptRowID = nil
        if let session {
            sessionMessageStore.upsert(sessionId: session.id, message: message)
        }
        if message.role == .assistant {
            markReadIfNeeded(messageId: message.id)
        }
        clearOptimisticUserMessageTracking()
        resetPendingResponse()
        if isBound {
            hapticFeedback.turnCompleted()
        }
    }

    func applyUserMessage(_ message: SessionMessage) {
        upsertConfirmedUserMessage(message)
        if let session {
            sessionMessageStore.upsert(sessionId: session.id, message: message)
        }
        isSending = false
        errorMessage = nil
    }

    func applyPendingUserMessage(_ message: SessionMessage) {
        upsertConfirmedUserMessage(message)
    }

    /// Replaces the message currently identified by `messageID` (a message id,
    /// not a row id), keeping the row it renders in.
    /// Returns false if no row shows that message.
    private func replaceMessage(messageID: String, with message: SessionMessage) -> Bool {
        guard let row = transcriptRows.last(where: { $0.messageID == messageID }) else {
            return false
        }
        upsertTranscriptMessage(rowID: row.id, message: message, isStreaming: false)
        return true
    }

    private func removeMessage(messageID: String) {
        for row in transcriptRows where row.messageID == messageID {
            if assistantDisplayDataByRowID[row.id] != nil {
                assistantDisplayDataByRowID[row.id] = nil
            }
        }
        transcriptRows.removeAll { $0.messageID == messageID }
        messagesByID[messageID] = nil
    }

    func appendPendingOptimisticUserMessage(
        content: String,
        attachments: [UploadedAttachment]
    ) -> String {
        let clientMessageId = UUID().uuidString.lowercased()
        let message = SessionMessage(
            id: clientMessageId,
            role: .user,
            parts: optimisticUserMessageParts(
                content: content,
                attachments: attachments
            ),
            metadata: .object(["optimistic": .bool(true)])
        )
        upsert(message)
        return clientMessageId
    }

    /// Replaces an optimistically client-set message with the server-side id
    func acceptOptimisticUserMessage(clientMessageId: String, messageId: String) {
        guard let optimisticMessage = messagesByID[clientMessageId],
              optimisticMessage.isOptimisticUserMessage,
              let row = transcriptRows.last(where: { $0.messageID == clientMessageId }) else {
            return
        }
        submittedAttachmentDrafts[clientMessageId] = nil
        let acceptedMessage = SessionMessage(
            id: messageId,
            role: optimisticMessage.role,
            parts: optimisticMessage.parts,
            metadata: optimisticMessage.removingOptimisticMarker.metadata
        )
        // The row keeps its id; the upsert reassigns its messageID and retires
        // the client-id entry from messagesByID.
        upsertTranscriptMessage(rowID: row.id, message: acceptedMessage, isStreaming: false)
        if let session {
            sessionMessageStore.upsert(sessionId: session.id, message: acceptedMessage)
        }
    }

    private func upsertConfirmedUserMessage(_ message: SessionMessage) {
        // if we already have an optimistic message for this message, mutate and replace it
        // if not, just upsert
        guard let optimisticMessage = orderedMessages.first(where: {
            $0.isOptimisticUserMessage && isServerConfirmation(message, of: $0)
        }) else {
            upsert(message)
            return
        }

        if !replaceMessage(messageID: optimisticMessage.id, with: message) {
            upsert(message)
        }
    }

    func messagesIncludingOptimisticUserMessages(
        in serverMessages: [SessionMessage]
    ) -> [SessionMessage] {
        var mergedMessages = serverMessages

        for optimisticMessage in orderedMessages where optimisticMessage.isOptimisticUserMessage {
            let hasServerMessage = serverMessages.contains {
                $0.id == optimisticMessage.id || isServerConfirmation($0, of: optimisticMessage)
            }
            if !hasServerMessage {
                mergedMessages.append(optimisticMessage)
            }
        }

        return mergedMessages
    }

    func messagesIncludingPendingUserMessage(
        in serverMessages: [SessionMessage]
    ) -> [SessionMessage] {
        guard let pendingUserMessage = clientState.pendingUserMessage,
              !serverMessages.contains(where: { $0.id == pendingUserMessage.id }) else {
            return serverMessages
        }
        return serverMessages + [pendingUserMessage]
    }

    func clearOptimisticUserMessageTracking() {
        // Content-only update: the message id and row are unchanged, so mutate
        // the map directly instead of going through the row upsert.
        for (id, message) in messagesByID where message.isOptimisticUserMessage {
            messagesByID[id] = message.removingOptimisticMarker
        }
    }

    func removePendingOptimisticUserMessage(
        restoreDraft: Bool,
        submittedContent: String? = nil
    ) {
        guard let optimisticMessage = orderedMessages.first(where: \.isOptimisticUserMessage) else {
            return
        }
        removeMessage(messageID: optimisticMessage.id)
        if restoreDraft {
            draftText = submittedContent ?? optimisticMessage.text
        }
    }

    private func isServerConfirmation(
        _ message: SessionMessage,
        of optimisticMessage: SessionMessage
    ) -> Bool {
        message.role == .user
            && message.id != optimisticMessage.id
            && message.text == optimisticMessage.text
            && imageFileURLs(in: message) == imageFileURLs(in: optimisticMessage)
    }

    private func optimisticUserMessageParts(
        content: String,
        attachments: [UploadedAttachment]
    ) -> [SessionMessage.Part] {
        var parts: [SessionMessage.Part] = []
        if !content.isEmpty {
            parts.append(.text(.init(text: content)))
        }
        parts.append(contentsOf: attachments.map { attachment in
            .file(.init(
                mediaType: attachment.mediaType,
                filename: attachment.filename,
                url: attachment.contentUrl,
                width: attachment.width,
                height: attachment.height
            ))
        })
        return parts
    }

    private func imageFileURLs(in message: SessionMessage) -> [String] {
        message.parts.compactMap { part in
            guard case .file(let file) = part,
                  file.mediaType.hasPrefix("image/") else {
                return nil
            }
            return file.url
        }
    }

    func restoreLastSubmittedAttachments() {
        guard let clientMessageId = orderedMessages.first(where: \.isOptimisticUserMessage)?.id,
              let submittedAttachments = submittedAttachmentDrafts.removeValue(
                forKey: clientMessageId
              ) else {
            return
        }
        attachmentStore.restore(submittedAttachments)
    }
}

extension AgentSessionViewModel {
    /// Messages in transcript order. Prefer `messagesByID` for id lookups.
    private var orderedMessages: [SessionMessage] {
        transcriptRows.compactMap { messagesByID[$0.messageID] }
    }

    func loadCachedMessages() async {
        guard let session else {
            return
        }
        do {
            let cachedRecords = try await sessionMessageStore.records(sessionId: session.id)
            guard !Task.isCancelled, !cachedRecords.isEmpty, messagesByID.isEmpty, !hasLoadedMessages else {
                return
            }

            markdownRenderCache.reset()
            rebuildTranscript(
                from: cachedRecords.map(\.message),
                streamingMessageIDs: Set(cachedRecords.filter(\.isStreaming).map(\.id))
            )
            hasLoadedMessages = true
        } catch {
            Logger.warning("Failed to load cached session messages:", error)
        }
    }

    func invalidateStreamAccumulator() {
        let previousAccumulator = streamAccumulator
        streamAccumulator = nil
        Task {
            await previousAccumulator?.finish()
        }
        messageThrottler?.cancel()
        messageThrottler = nil
        streamGeneration += 1
    }

    func replaceStreamAccumulator(
        initialChunks: [SessionStreamChunk] = [],
        messageMetadata: SessionStreamMessageMetadata? = nil
    ) {
        invalidateStreamAccumulator()
        installStreamAccumulator(
            initialChunks: initialChunks,
            messageMetadata: messageMetadata
        )
    }

    func installStreamAccumulator(
        initialChunks: [SessionStreamChunk] = [],
        messageMetadata: SessionStreamMessageMetadata? = nil
    ) {
        let generation = streamGeneration

        messageThrottler = SchedulerLatestValueThrottler(
            interval: .milliseconds(200),
            scheduler: .main
        ) { [weak self] message in
            guard let self, streamGeneration == generation else {
                return
            }
            applyStreamingMessage(message)
        }

        streamAccumulator = SessionMessageStreamAccumulator(
            initialChunks: initialChunks,
            messageMetadata: messageMetadata,
            onStatus: { [weak self] status in
                Task { @MainActor [weak self] in
                    guard let self, streamGeneration == generation else {
                        return
                    }
                    applyStreamStatus(status)
                }
            },
            onMessage: { [weak self] message in
                Task { @MainActor [weak self] in
                    guard let self, streamGeneration == generation else {
                        return
                    }
                    messageThrottler?.submit(message)
                }
            }
        )
    }

    private func applyStreamStatus(_ status: SessionMessageStreamStatus) {
        guard streamStatus != status else {
            return
        }

        let previousErrorDescription = streamStatus.errorDescription
        streamStatus = status

        guard
            let errorDescription = status.errorDescription,
            errorDescription != previousErrorDescription
        else {
            return
        }

        errorMessage = errorDescription
    }

    func applyStreamingMessage(_ message: SessionMessage) {
        let rowID = transcriptRowID(for: message)
        streamingTranscriptRowID = rowID
        upsertTranscriptMessage(
            rowID: rowID,
            message: message,
            isStreaming: true
        )
        guard let session else {
            return
        }
        sessionMessageStore.upsert(
            sessionId: session.id,
            message: message,
            isStreaming: true
        )
    }

    func clearStreamingState(removeActiveTranscript: Bool) {
        streamStatus = .init()
        guard removeActiveTranscript, let streamingTranscriptRowID else {
            self.streamingTranscriptRowID = nil
            return
        }

        if let row = transcriptRows.last(where: { $0.id == streamingTranscriptRowID && $0.isStreaming }) {
            messagesByID[row.messageID] = nil
            transcriptRows.removeAll { $0.id == row.id }
        }
        assistantDisplayDataByRowID[streamingTranscriptRowID] = nil
        self.streamingTranscriptRowID = nil
    }

    func rebuildTranscriptDisplayData() {
        assistantDisplayDataByRowID = transcriptRows.reduce(into: [:]) { result, row in
            guard let message = messagesByID[row.messageID], message.role != .user else { return }
            result[row.id] = makeDisplayData(
                id: row.id,
                for: message,
                isStreaming: row.isStreaming
            )
        }
    }

    /// Rebuilds transcript rows from ordered messages and their streaming state.
    func rebuildTranscript(
        from messages: [SessionMessage],
        streamingMessageIDs: Set<String> = []
    ) {
        transcriptRows = messages.map { message in
            TranscriptRow(
                id: transcriptRowID(for: message),
                messageID: message.id,
                isStreaming: streamingMessageIDs.contains(message.id)
            )
        }
        messagesByID = Dictionary(messages.map { ($0.id, $0) }) { _, latest in latest }
        streamingTranscriptRowID = transcriptRows.last(where: \.isStreaming)?.id
        rebuildTranscriptDisplayData()
        assertTranscriptStateConsistency()
    }

    func transcriptRowID(for message: SessionMessage) -> String {
        if let existingRow = transcriptRows.last(where: { $0.messageID == message.id }) {
            return existingRow.id
        }

        return SessionTranscriptItem.messageItemID(for: message.id)
    }

    /// The single write path for transcript content, keyed by row id. Optimistic
    /// messages receive their server id in place without changing row identity.
    func upsertTranscriptMessage(rowID: String, message: SessionMessage, isStreaming: Bool) {
        if let index = transcriptRows.lastIndex(where: { $0.id == rowID }) {
            let previousMessageID = transcriptRows[index].messageID
            if previousMessageID != message.id {
                messagesByID[previousMessageID] = nil
            }
            transcriptRows[index].messageID = message.id
            transcriptRows[index].isStreaming = isStreaming
        } else {
            transcriptRows.append(TranscriptRow(
                id: rowID,
                messageID: message.id,
                isStreaming: isStreaming
            ))
        }
        messagesByID[message.id] = message

        if message.role != .user {
            assistantDisplayDataByRowID[rowID] = makeDisplayData(
                id: rowID,
                for: message,
                isStreaming: isStreaming
            )
        }
        assertTranscriptStateConsistency()
    }

    func assertTranscriptStateConsistency() {
        #if DEBUG
        for row in transcriptRows {
            assert(
                messagesByID[row.messageID] != nil,
                "Transcript row \(row.id) references missing message \(row.messageID)"
            )
        }
        #endif
    }

    private func makeDisplayData(
        id: String,
        for message: SessionMessage,
        isStreaming: Bool
    ) -> AgentSessionView.MessageDisplayData {
        var renderItems = transcriptBuilder.build(
            message: message,
            providerId: transcriptProvider
        )
        renderItems = markdownRenderCache.renderItems(from: renderItems, isStreaming: isStreaming)
        let finalResponseStartIndex = isStreaming ? nil : transcriptBuilder.finalResponseStartIndex(
            renderItems: renderItems
        )

        return AgentSessionView.MessageDisplayData(
            id: id,
            message: message,
            renderItems: renderItems,
            finalResponseStartIndex: finalResponseStartIndex
        )
    }
}
