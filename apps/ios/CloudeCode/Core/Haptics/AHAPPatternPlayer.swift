import CoreHaptics
import Domain
import Foundation

@MainActor
protocol AHAPPatternPlaying {
    func prepare()
    func play(_ patternURL: URL)
    func stop()
}

@MainActor
final class CoreHapticsAHAPPatternPlayer: AHAPPatternPlaying {
    private let engine: CHHapticEngine?

    init() {
        engine = Self.makeEngine()
    }

    func prepare() {
        guard let engine else {
            return
        }
        do {
            try engine.start()
        } catch {
            Logger.warning("Failed to prepare haptic engine:", error)
        }
    }

    func play(_ patternURL: URL) {
        guard let engine else {
            return
        }
        do {
            try engine.start()
            try engine.playPattern(from: patternURL)
        } catch {
            Logger.warning("Failed to play AHAP haptic pattern:", error)
        }
    }

    func stop() {
        engine?.stop(completionHandler: nil)
    }

    private static func makeEngine() -> CHHapticEngine? {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            return nil
        }
        do {
            return try CHHapticEngine()
        } catch {
            Logger.warning("Failed to create haptic engine:", error)
            return nil
        }
    }
}
