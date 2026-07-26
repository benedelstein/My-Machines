import API
import Entities

extension AgentSessionViewModel {
    var isConnected: Bool {
        connectionState == .connected
    }

    var composerPlaceholder: String {
        "Send a message..."
    }

    enum Context {
        case session(SessionSummaryModel)
        case draft(NewSessionDraft)

        var session: SessionSummaryModel? {
            guard case .session(let session) = self else {
                return nil
            }
            return session
        }

        var draft: NewSessionDraft? {
            guard case .draft(let draft) = self else {
                return nil
            }
            return draft
        }
    }

    /// Canonical cached model; cache and socket updates propagate through this reference.
    var session: SessionSummaryModel? {
        context.session
    }

    var draft: NewSessionDraft? {
        context.draft
    }

    var isDraftMode: Bool {
        if case .draft = context {
            return true
        }
        return false
    }
}
