import Combine
import Domain
import Entities
import Foundation
import Observation
import UserNotifications

enum HomeDestination: Hashable {
    case session(SessionSummaryModel)
    case newSession(id: UUID)
}

@MainActor
@Observable
final class HomeRouter: NotificationHandlerDelegate {
    var path: [HomeDestination] = []

    @ObservationIgnored private let notificationHandler: NotificationHandler
    @ObservationIgnored private let sessionSummaryStore: SessionSummaryStore
    @ObservationIgnored private var navigationRequestID: Int = 0
    /// Maps a `.newSession` destination's local draft UUID to the server session id
    /// once that draft creates its session. `HomeDestination.newSession` is keyed by
    /// a client-side UUID so the pushed screen keeps its identity (no rebuild) when
    /// the session comes into existence; this table lets `activeSessionId` resolve
    /// those destinations to real session ids for notification suppression/routing.
    @ObservationIgnored private var createdSessionIDs: [UUID: String] = [:]
    @ObservationIgnored private var cancellables: Set<AnyCancellable> = Set<AnyCancellable>()

    var notificationTap: NotificationRoute? {
        notificationHandler.notificationTap
    }

    init(
        notificationHandler: NotificationHandler,
        sessionSummaryStore: SessionSummaryStore,
        sessionCreated: AnyPublisher<String, Never>
    ) {
        self.notificationHandler = notificationHandler
        self.sessionSummaryStore = sessionSummaryStore

        sessionCreated
            .sink { [weak self] sessionId in
                // The subject only fires from MainActor view-model code.
                MainActor.assumeIsolated {
                    self?.adoptDraftSession(id: sessionId)
                }
            }
            .store(in: &cancellables)
    }

    /// Installs this router as the foreground notification presenter while Home is active.
    func start() {
        notificationHandler.delegate = self
    }

    /// Clears the foreground notification delegate if this router is still installed.
    func stop() {
        if notificationHandler.delegate === self {
            notificationHandler.delegate = nil
        }
    }

    /// Suppresses foreground notifications for the currently visible session.
    func notificationHandler(
        _ handler: NotificationHandler,
        presentationOptionsFor route: NotificationRoute
    ) -> UNNotificationPresentationOptions {
        switch route {
        case .session(let sessionId, _):
            activeSessionId == sessionId
                ? []
                : NotificationHandler.defaultPresentationOptions
        }
    }

    /// Routes a notification tap by replacing Home's navigation path with the target session.
    func handleNotificationTap(_ route: NotificationRoute) async {
        navigationRequestID += 1
        let requestID = navigationRequestID

        switch route {
        case .session(let sessionId, _):
            guard activeSessionId != sessionId else {
                notificationHandler.consumeTap(route)
                return
            }

            guard let target = await sessionSummary(for: sessionId) else {
                Logger.warning("Notification target session missing:", sessionId)
                notificationHandler.consumeTap(route)
                return
            }

            if !path.isEmpty {
                path.removeAll()
                createdSessionIDs.removeAll()
                // Future optimization: replace this fixed pause with a scroll view delegate
                // completion signal once navigation pop exposes a reliable finish callback.
                try? await Task.sleep(nanoseconds: 400_000_000)

                guard requestID == navigationRequestID, !Task.isCancelled else {
                    return
                }
            }

            path = [.session(target)]
            notificationHandler.consumeTap(route)
        }
    }

    /// Pushes an independent draft session destination.
    func pushNewSession() {
        path.append(.newSession(id: UUID()))
    }

    /// Associates a created session with the active draft route without rebuilding the screen.
    /// Sessions are only created from the topmost draft destination.
    func adoptDraftSession(id sessionId: String) {
        guard let draftId = path.last?.draftId else {
            return
        }
        createdSessionIDs[draftId] = sessionId
    }

    /// Routes the currently pending notification tap, if one exists.
    func handlePendingNotificationTap() async {
        guard let route = notificationHandler.notificationTap else {
            return
        }

        await handleNotificationTap(route)
    }

    private func sessionSummary(for sessionId: String) async -> SessionSummaryModel? {
        do {
            return try await sessionSummaryStore.get([sessionId]).first
        } catch {
            Logger.warning("Notification target session lookup failed:", sessionId, error)
            return nil
        }
    }

    private var activeSessionId: String? {
        path.last?.sessionId(createdSessionIDs: createdSessionIDs)
    }
}

private extension HomeDestination {
    @MainActor
    func sessionId(createdSessionIDs: [UUID: String]) -> String? {
        switch self {
        case .session(let session):
            session.id
        case .newSession(let id):
            createdSessionIDs[id]
        }
    }

    var draftId: UUID? {
        guard case .newSession(let id) = self else {
            return nil
        }
        return id
    }
}
