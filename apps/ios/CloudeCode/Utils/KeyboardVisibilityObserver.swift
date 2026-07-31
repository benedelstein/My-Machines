import Observation
import UIKit

/// Observable keyboard visibility state backed by UIKit keyboard notifications.
@Observable
final class KeyboardVisibilityObserver {
    /// Whether the keyboard currently intersects the main screen.
    private(set) var isVisible: Bool = false
    /// Height of the keyboard intersection with the main screen.
    private(set) var visibleHeight: CGFloat = 0
    /// Final keyboard frame reported by the most recent notification.
    private(set) var endFrame: CGRect = .zero
    /// Animation metadata from the most recent keyboard transition.
    private(set) var transition: KeyboardTransition?
    /// Monotonic trigger value that changes for every keyboard transition notification.
    private(set) var transitionID: Int = 0

    private let notificationCenter: NotificationCenter
    private var observers: [NSObjectProtocol] = []

    /// Creates an observer that listens for UIKit keyboard notifications.
    init(notificationCenter: NotificationCenter = .default) {
        self.notificationCenter = notificationCenter
    }

    deinit {
        observers.forEach { observer in
            notificationCenter.removeObserver(observer)
        }
    }

    /// Starts observing keyboard transition notifications.
    func start() {
        guard observers.isEmpty else { return }

        observers = [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardWillHideNotification
        ].map { notificationName in
            notificationCenter.addObserver(
                forName: notificationName,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                self?.handle(notification)
            }
        }
    }

    /// Stops observing keyboard transition notifications.
    func stop() {
        removeObservers()
    }

    private func handle(_ notification: Notification) {
        let endFrame = keyboardEndFrame(from: notification)
        let transition = KeyboardTransition(
            startTime: ProcessInfo.processInfo.systemUptime,
            duration: keyboardAnimationDuration(from: notification),
            options: keyboardAnimationOptions(from: notification)
        )

        self.endFrame = endFrame
        self.transition = transition
        transitionID += 1

        guard notification.name != UIResponder.keyboardWillHideNotification else {
            isVisible = false
            visibleHeight = 0
            return
        }

        let visibleFrame = UIScreen.main.bounds.intersection(endFrame)
        isVisible = !visibleFrame.isNull && visibleFrame.height > 0
        visibleHeight = isVisible ? visibleFrame.height : 0
    }

    private func removeObservers() {
        observers.forEach { observer in
            notificationCenter.removeObserver(observer)
        }
        observers = []
    }

    private func keyboardEndFrame(from notification: Notification) -> CGRect {
        notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .zero
    }

    private func keyboardAnimationDuration(from notification: Notification) -> TimeInterval {
        guard let duration = notification
            .userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber else {
            return 0.25
        }

        return duration.doubleValue
    }

    private func keyboardAnimationOptions(from notification: Notification) -> UIView.AnimationOptions {
        let curveRawValue = (
            notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber
        )?.uintValue ?? UInt(UIView.AnimationCurve.easeInOut.rawValue)
        let curveOptions = UIView.AnimationOptions(rawValue: curveRawValue << 16)

        return [.beginFromCurrentState, .allowUserInteraction, .layoutSubviews, curveOptions]
    }
}
