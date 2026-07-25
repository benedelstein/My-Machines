import API
import Combine
import CoreAPI
import Domain
import Entities
import Foundation

private enum DraftSendError: LocalizedError {
    case missingDraft
    case missingSocket
    case modelUnavailable

    var errorDescription: String? {
        switch self {
        case .missingDraft:
            "New session state is unavailable."
        case .missingSocket:
            "Session connection is unavailable."
        case .modelUnavailable:
            "Wait for the model catalog before sending."
        }
    }
}

extension AgentSessionViewModel {
    /// Interrupt the active agent response while preserving the current draft.
    func interruptResponse() {
        guard canInterruptResponse, !isCancelling, let socket else {
            return
        }

        isCancelling = true
        errorMessage = nil
        Task { [socket] in
            do {
                try await socket.cancelOperation()
            } catch {
                self.isCancelling = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    /// Submit the composed message.
    func submitUserMessage() {
        let content = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        let uploadedAttachments = attachmentStore.uploadedDescriptors
        guard !content.isEmpty || !uploadedAttachments.isEmpty,
              !attachmentStore.hasPendingOrFailedUploads,
              !isSending,
              !isResponding else {
            return
        }

        let submittedDrafts = attachmentStore.attachments
        draftText = ""
        attachmentStore.clearAfterSubmit()
        let clientMessageId = appendPendingOptimisticUserMessage(
            content: content,
            attachments: uploadedAttachments
        )
        submittedAttachmentDrafts[clientMessageId] = submittedDrafts
        isSending = true
        isWaitingForResponse = true
        errorMessage = nil
        persistClientState()

        if isDraftMode {
            isCreatingSession = true
            sendDraftSessionMessage(
                content: content,
                uploadedAttachments: uploadedAttachments,
                submittedDrafts: submittedDrafts,
                clientMessageId: clientMessageId
            )
            return
        }

        sendExistingSessionMessage(
            content: content,
            uploadedAttachments: uploadedAttachments,
            submittedDrafts: submittedDrafts,
            clientMessageId: clientMessageId
        )
    }

    private func sendDraftSessionMessage(
        content: String,
        uploadedAttachments: [UploadedAttachment],
        submittedDrafts: [ImageAttachmentDraft],
        clientMessageId: String
    ) {
        Task { [uploadedAttachments] in
            defer {
                self.isCreatingSession = false
            }
            do {
                guard let selectedModel = self.localModelSelection, self.isModelSelectionValid else {
                    throw DraftSendError.modelUnavailable
                }
                let response = try await draft?.createSession(
                    content: content,
                    attachmentIds: uploadedAttachments.map(\.attachmentId),
                    model: selectedModel
                )
                guard let response else {
                    throw DraftSendError.missingDraft
                }
                adoptCreatedSession(response)
                self.isSending = false
            } catch {
                self.recordSendError(
                    error,
                    submittedContent: content,
                    submittedAttachments: submittedDrafts,
                    clientMessageId: clientMessageId
                )
            }
        }
    }

    private func sendExistingSessionMessage(
        content: String,
        uploadedAttachments: [UploadedAttachment],
        submittedDrafts: [ImageAttachmentDraft],
        clientMessageId: String
    ) {
        guard let socket else {
            recordSendError(
                DraftSendError.missingSocket,
                submittedContent: content,
                submittedAttachments: submittedDrafts,
                clientMessageId: clientMessageId
            )
            return
        }

        Task { [socket, uploadedAttachments] in
            do {
                let selectedModel = self.stagedModelChange
                try await socket.sendChat(
                    content: content.isEmpty ? nil : content,
                    attachmentIds: uploadedAttachments.map(\.attachmentId),
                    clientMessageId: clientMessageId,
                    model: selectedModel?.model,
                    effort: selectedModel?.effort
                )
                self.isSending = false
            } catch {
                self.recordSendError(
                    error,
                    submittedContent: content,
                    submittedAttachments: submittedDrafts,
                    clientMessageId: clientMessageId
                )
            }
        }
    }

    private func adoptCreatedSession(_ response: CreateSessionResponse) {
        guard let draft, let selectedRepo = draft.selectedRepo else {
            return
        }

        let now = ISO8601DateFormatter().string(from: Date())
        let summary = SessionSummary(
            id: response.sessionId,
            repoId: selectedRepo.id,
            repoFullName: selectedRepo.fullName,
            title: response.title,
            archived: false,
            status: .preparing,
            workingState: "responding",
            createdAt: now,
            updatedAt: now,
            hasUnread: false
        )
        let session = sessionSummaryStore.putSnapshotsToDisk([summary])[0]
        context = .session(session)
        clientState = Self.initialClientState(from: session)
        attachmentStore.adoptSessionId(response.sessionId)
        // Lets HomeRouter map this screen's draft route to the real session id.
        sessionCreatedSubject.send(response.sessionId)

        let socket = makeSocket(response.sessionId)
        self.socket = socket
        // Creation is deliberately not cancelled when the user navigates away:
        // the session exists server-side and was persisted above so it shows
        // up in the session list. Only connecting the socket is pointless once
        // the screen is gone; a later bind() will connect it.
        guard isBound else {
            return
        }
        connectionState = .connecting
        _ = startSocketPipeline(socket: socket)
    }

    private func recordSendError(
        _ error: any Error,
        submittedContent: String,
        submittedAttachments: [ImageAttachmentDraft],
        clientMessageId: String
    ) {
        errorMessage = error.localizedDescription
        submittedAttachmentDrafts[clientMessageId] = nil
        removePendingOptimisticUserMessage(
            restoreDraft: draftText.isEmpty,
            submittedContent: submittedContent
        )
        attachmentStore.restore(submittedAttachments)
        resetPendingResponse()
        persistClientState()
    }
}
