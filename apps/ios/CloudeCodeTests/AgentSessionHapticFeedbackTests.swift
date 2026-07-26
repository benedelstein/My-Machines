@testable import API
import CoreAPI
import Testing
@testable import CloudeCode

extension AgentSessionTranscriptStateTests {
    @Test func agentSessionHapticsComposeGenericAndPatternPlayers() {
        let feedbackPlayer = RecordingFeedbackPlayer()
        let patternPlayer = RecordingPatternPlayer()
        let completionPatternURL = URL(fileURLWithPath: "/TurnCompletion.ahap")
        let haptics = AgentSessionHapticFeedback(
            feedbackPlayer: feedbackPlayer,
            patternPlayer: patternPlayer,
            completionPatternURL: completionPatternURL
        )

        haptics.prepare()
        haptics.turnStarted()
        haptics.turnCompleted()
        haptics.stop()

        #expect(feedbackPlayer.feedback == [.light])
        #expect(patternPlayer.events == [
            .prepared,
            .played(completionPatternURL),
            .stopped
        ])
    }

    @Test func agentFinishTriggersCompletionHapticWhileViewModelIsBound() {
        let hapticFeedback = RecordingHapticFeedback()
        let viewModel = makeViewModel(hapticFeedback: hapticFeedback)
        viewModel.isBound = true

        viewModel.applyAgentFinish(assistantMessage(id: "assistant-1", text: "Complete"))

        #expect(hapticFeedback.events == [.turnCompleted])
    }

    @Test func agentFinishDoesNotTriggerCompletionHapticWhileViewModelIsUnbound() {
        let hapticFeedback = RecordingHapticFeedback()
        let viewModel = makeViewModel(hapticFeedback: hapticFeedback)

        viewModel.applyAgentFinish(assistantMessage(id: "assistant-1", text: "Complete"))

        #expect(hapticFeedback.events.isEmpty)
    }

    @Test func firstLiveChunkTriggersTurnStartHapticWhileViewModelIsBound() async {
        let hapticFeedback = RecordingHapticFeedback()
        let viewModel = makeViewModel(hapticFeedback: hapticFeedback)
        viewModel.isBound = true

        await viewModel.handle(.agentChunks(chunks: [], messageMetadata: nil))
        await viewModel.handle(.agentChunks(
            chunks: initialMessageChunks(),
            messageMetadata: nil
        ))
        await viewModel.handle(.agentChunks(
            chunks: [messageDeltaChunk(delta: "Second")],
            messageMetadata: nil
        ))

        #expect(hapticFeedback.events == [.turnStarted])
    }

    @Test func firstLiveChunkDoesNotTriggerTurnStartHapticWhileViewModelIsUnbound() async {
        let hapticFeedback = RecordingHapticFeedback()
        let viewModel = makeViewModel(hapticFeedback: hapticFeedback)

        await viewModel.handle(.agentChunks(
            chunks: initialMessageChunks(),
            messageMetadata: nil
        ))

        #expect(hapticFeedback.events.isEmpty)
    }

    @Test func bindingPreparesAndUnbindingStopsHapticFeedback() async {
        let hapticFeedback = RecordingHapticFeedback()
        let viewModel = makeViewModel(hapticFeedback: hapticFeedback)

        let bindTask = Task {
            await viewModel.bind()
        }
        await Task.yield()
        viewModel.unbind()
        await bindTask.value

        #expect(hapticFeedback.events.first == .prepared)
        #expect(hapticFeedback.events.last == .stopped)
    }

    final class RecordingHapticFeedback: AgentSessionHapticFeedbackProviding {
        enum Event: Equatable {
            case prepared
            case turnStarted
            case turnCompleted
            case stopped
        }

        private(set) var events: [Event] = []

        func prepare() {
            events.append(.prepared)
        }

        func turnStarted() {
            events.append(.turnStarted)
        }

        func turnCompleted() {
            events.append(.turnCompleted)
        }

        func stop() {
            events.append(.stopped)
        }
    }

    final class NoopHapticFeedback: AgentSessionHapticFeedbackProviding {
        func prepare() {}
        func turnStarted() {}
        func turnCompleted() {}
        func stop() {}
    }

    final class RecordingFeedbackPlayer: HapticFeedbackPlaying {
        private(set) var feedback: [HapticFeedback] = []

        func play(_ feedback: HapticFeedback) {
            self.feedback.append(feedback)
        }
    }

    final class RecordingPatternPlayer: AHAPPatternPlaying {
        enum Event: Equatable {
            case prepared
            case played(URL)
            case stopped
        }

        private(set) var events: [Event] = []

        func prepare() {
            events.append(.prepared)
        }

        func play(_ patternURL: URL) {
            events.append(.played(patternURL))
        }

        func stop() {
            events.append(.stopped)
        }
    }

    private func initialMessageChunks() -> [SessionStreamChunk] {
        [
            SessionStreamChunk(.start(.init(messageId: "message-1"))),
            SessionStreamChunk(.textStart(.init(id: "text-1"))),
            messageDeltaChunk(delta: "First")
        ]
    }

    private func messageDeltaChunk(delta: String) -> SessionStreamChunk {
        SessionStreamChunk(.textDelta(.init(id: "text-1", delta: delta)))
    }
}
