import SwiftUI

enum ToastPosition {
    case top
}

struct ToastConfig {
    var duration: TimeInterval = 3
    var padding: EdgeInsets = .init()
    var position: ToastPosition = .top
    var ignoresSafeArea: Bool = true
    var insertionAnimation: Animation = .spring(response: 0.25, dampingFraction: 0.9)
    var removalAnimation: Animation = .spring(response: 0.25, dampingFraction: 0.9)
    var dimTransition: Bool = true
}

extension ToastConfig {
    static var cloudeDefault: ToastConfig {
        ToastConfig()
    }
}
