import Foundation

@MainActor
protocol AgentSessionHapticFeedbackProviding {
    func prepare()
    func turnStarted()
    func turnCompleted()
    func stop()
}

@MainActor
final class AgentSessionHapticFeedback: AgentSessionHapticFeedbackProviding {
    private let feedbackPlayer: any HapticFeedbackPlaying
    private let patternPlayer: any AHAPPatternPlaying
    private let completionPatternURL: URL?

    init(
        feedbackPlayer: (any HapticFeedbackPlaying)? = nil,
        patternPlayer: (any AHAPPatternPlaying)? = nil,
        completionPatternURL: URL? = Bundle.main.url(
            forResource: "TurnCompletion",
            withExtension: "ahap"
        )
    ) {
        self.feedbackPlayer = feedbackPlayer ?? SystemHapticFeedbackPlayer()
        self.patternPlayer = patternPlayer ?? CoreHapticsAHAPPatternPlayer()
        self.completionPatternURL = completionPatternURL
    }

    func prepare() {
        patternPlayer.prepare()
    }

    func turnStarted() {
        feedbackPlayer.play(.light)
    }

    func turnCompleted() {
        guard let completionPatternURL else {
            return
        }
        patternPlayer.play(completionPatternURL)
    }

    func stop() {
        patternPlayer.stop()
    }
}
