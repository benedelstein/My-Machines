import UIKit

enum HapticFeedback: Equatable {
    case light
    case soft(intensity: CGFloat)
    case success
    case error
}

protocol HapticFeedbackPlaying {
    @MainActor
    func play(_ feedback: HapticFeedback)
}

struct NoopHapticFeedbackPlayer: HapticFeedbackPlaying {
    @MainActor
    func play(_: HapticFeedback) {}
}

@MainActor
final class SystemHapticFeedbackPlayer: HapticFeedbackPlaying {
    private let lightFeedback = UIImpactFeedbackGenerator(style: .light)
    private let softFeedback = UIImpactFeedbackGenerator(style: .soft)
    private let notificationFeedback = UINotificationFeedbackGenerator()

    func play(_ feedback: HapticFeedback) {
        switch feedback {
        case .light:
            lightFeedback.impactOccurred()
        case .soft(let intensity):
            softFeedback.impactOccurred(intensity: intensity)
        case .success:
            notificationFeedback.notificationOccurred(.success)
        case .error:
            notificationFeedback.notificationOccurred(.error)
        }
    }
}
