import API
import Combine
import CoreAPI
import Domain
import FirebaseMessaging
import Foundation
import UIKit
import UserNotifications

final class NotificationRegistrationService: NSObject {
    private struct UploadRequest: Equatable {
        let userId: String
        let token: String
    }

    private let notificationsAPI: any NotificationsAPIProviding
    private let deviceIdentifierStore: DeviceIdentifierStore
    private let authUserPublisher: AnyPublisher<String?, Never>
    private let notificationHandler: any NotificationHandling
    @Published private var fcmToken: String?
    private var cancellables: Set<AnyCancellable> = Set<AnyCancellable>()
    private var uploadTask: Task<Void, Never>?
    private var lastUploadRequest: UploadRequest?
    private var hasStarted: Bool = false
    private var receivedNotificationIds: Set<String> = Set<String>()

    init(
        notificationsAPI: any NotificationsAPIProviding,
        authUserPublisher: AnyPublisher<String?, Never>,
        notificationHandler: any NotificationHandling,
        deviceIdentifierStore: DeviceIdentifierStore = DeviceIdentifierStore()
    ) {
        self.notificationsAPI = notificationsAPI
        self.authUserPublisher = authUserPublisher
        self.notificationHandler = notificationHandler
        self.deviceIdentifierStore = deviceIdentifierStore
    }

    func start() {
        guard !hasStarted else { return }
        hasStarted = true

        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self
        UIApplication.shared.registerForRemoteNotifications()

        authUserPublisher
            .combineLatest($fcmToken)
            .sink { [weak self] userId, token in
                guard let self else { return }
                guard let userId, let token else {
                    self.lastUploadRequest = nil
                    return
                }

                let request = UploadRequest(userId: userId, token: token)
                guard request != self.lastUploadRequest else { return }

                self.lastUploadRequest = request
                self.uploadTask?.cancel()
                self.uploadTask = Task { [weak self] in
                    await self?.uploadToken(token)
                }
            }
            .store(in: &cancellables)
    }

    /// Handles the remote notification payload supplied in app launch options.
    @MainActor
    func handleLaunchRemoteNotification(_ userInfo: [AnyHashable: Any]) {
        handleTappedNotification(userInfo: userInfo, failureMessage: "Unable to decode launch notification payload")
    }

    @MainActor
    func requestNotificationAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .badge, .sound]
            )
            if granted {
                Logger.debug("Notification authorization granted")
            } else {
                Logger.debug("Notification authorization not granted")
            }
        } catch {
            Logger.warning("Notification authorization request failed", error)
        }
    }

    private func uploadToken(_ token: String) async {
        guard let deviceId = await deviceIdentifierStore.deviceId() else {
            Logger.warning("Skipping FCM token upload because identifierForVendor is unavailable")
            return
        }

        do {
            try await notificationsAPI.registerFcmToken(deviceId: deviceId, token: token)
            Logger.debug("Uploaded FCM token \(token)")
        } catch {
            Logger.warning("FCM token upload failed", error)
        }
    }

    private func handleToken(_ token: String) {
        fcmToken = token
    }

    @MainActor
    private func handleTappedNotification(userInfo: [AnyHashable: Any], failureMessage: String) {
        appDidReceiveMessage(userInfo)

        guard let payload = NotificationPayload(from: userInfo) else {
            Logger.warning(
                failureMessage,
                "keys:",
                Array(userInfo.keys)
            )
            return
        }

        notificationHandler.handleNotificationTap(payload)
    }

    @MainActor
    private func presentationOptions(
        userInfo: [AnyHashable: Any],
        failureMessage: String
    ) -> UNNotificationPresentationOptions {
        guard
            let notificationData = NotificationMessageData(from: userInfo),
            let payload = NotificationPayload(jsonString: notificationData.payload)
        else {
            Logger.warning(
                failureMessage,
                "keys:",
                Array(userInfo.keys)
            )
            return NotificationHandler.defaultPresentationOptions
        }

        guard shouldProcessNotificationDelivery(notificationData) else {
            Logger.debug("Skipping duplicate notification delivery", notificationData.notificationId)
            return []
        }

        appDidReceiveMessage(userInfo)
        return notificationHandler.presentationOptions(forForeground: payload)
    }

    @MainActor
    private func appDidReceiveMessage(_ userInfo: [AnyHashable: Any]) {
        // NOTE: MUST BE CALLED ON MAIN THREAD
        // Firebase's analytics hook reads `UIApplication.applicationState`.
        Messaging.messaging().appDidReceiveMessage(userInfo)
    }

    private func shouldProcessNotificationDelivery(_ notificationData: NotificationMessageData) -> Bool {
        receivedNotificationIds.insert(notificationData.notificationId).inserted
    }
}

extension NotificationRegistrationService: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        handleToken(fcmToken)
    }
}

extension NotificationRegistrationService: UNUserNotificationCenterDelegate {
    // These async notification delegate methods must stay on MainActor. UIKit
    // can otherwise finish notification background-event cleanup off-main and crash.
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        return presentationOptions(
            userInfo: userInfo,
            failureMessage: "Unable to decode foreground notification payload"
        )
    }

    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        handleTappedNotification(
            userInfo: userInfo,
            failureMessage: "Unable to decode tapped notification payload"
        )
    }
}
