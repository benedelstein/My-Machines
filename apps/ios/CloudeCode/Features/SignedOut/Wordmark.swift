import SwiftUI

struct Wordmark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.hapticFeedbackPlayer) private var haptics
    @State private var isVisible = false
    @State private var extraEyeCount = 0
    @State private var eyeSequenceID = 0
    @State private var toggleTargetEyeCount: Int?

    var body: some View {
        Button {
            toggleEyes()
        } label: {
            ZStack {
                if isVisible {
                    HStack(alignment: .firstTextBaseline, spacing: WordmarkStyle.spacing) {
                        Text("My")
                            .font(.custom(WordmarkStyle.schoolbellFontName, size: WordmarkStyle.myFontSize))

                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            Text("Mach")

                            WordmarkI()

                            if extraEyeCount >= 1 {
                                WordmarkI()
                                    .transition(extraEyeTransition)
                            }

                            if extraEyeCount >= 2 {
                                WordmarkI()
                                    .transition(extraEyeTransition)
                            }

                            if extraEyeCount >= 3 {
                                WordmarkI()
                                    .transition(extraEyeTransition)
                            }

                            if extraEyeCount >= 4 {
                                WordmarkI()
                                    .transition(extraEyeTransition)
                            }

                            Text("nes")
                        }
                        .font(.custom(WordmarkStyle.machinesFontName, size: WordmarkStyle.machinesFontSize))
                    }
                    .transition(.blurReplace)
                }
            }
            .foregroundStyle(.white)
            .fixedSize()
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .buttonStyle(.highlight(cornerRadius: 14, highlightColor: .white.opacity(0.08)))
        .accessibilityLabel("My Machines")
        .accessibilityHint("Toggles the animated eyes")
        .task(id: eyeSequenceID) {
            if let toggleTargetEyeCount {
                await animateEyes(to: toggleTargetEyeCount)
            } else {
                await animateIntro()
            }
        }
    }

    private var extraEyeTransition: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.2, anchor: .bottom)
                .combined(with: .opacity),
            removal: .opacity
                .animation(.easeOut(duration: 0.15))
        )
    }

    private var eyeInsertionAnimation: Animation {
        .spring(duration: 0.42, bounce: 0.5)
    }

    private var eyeRemovalAnimation: Animation {
        .spring(duration: 0.24, bounce: 0.45)
    }

    @MainActor
    private func animateIntro() async {
        guard !isVisible else {
            return
        }

        if reduceMotion {
            isVisible = true
            return
        }

        guard await wait(milliseconds: 300) else {
            return
        }

        withAnimation(.easeOut(duration: 0.25)) {
            isVisible = true
        }

        guard await wait(milliseconds: 850) else {
            return
        }

        await animateEyes(to: WordmarkStyle.maximumExtraEyeCount)

        guard await wait(milliseconds: 750) else {
            return
        }

        await animateEyes(to: 0)
    }

    @MainActor
    private func animateEyes(to targetCount: Int) async {
        if reduceMotion {
            extraEyeCount = targetCount
            return
        }

        while extraEyeCount != targetCount {
            guard !Task.isCancelled else {
                return
            }

            let isExpanding = extraEyeCount < targetCount
            let nextCount = extraEyeCount + (isExpanding ? 1 : -1)
            transitionEyes(
                to: nextCount,
                animation: isExpanding ? eyeInsertionAnimation : eyeRemovalAnimation
            )

            guard nextCount != targetCount else {
                return
            }

            let staggerMilliseconds = isExpanding ? 70 : 65
            guard await wait(milliseconds: staggerMilliseconds) else {
                return
            }
        }
    }

    @MainActor
    private func toggleEyes() {
        guard isVisible else {
            return
        }

        let nextTarget: Int
        if let toggleTargetEyeCount {
            nextTarget = toggleTargetEyeCount == WordmarkStyle.maximumExtraEyeCount
                ? 0
                : WordmarkStyle.maximumExtraEyeCount
        } else {
            nextTarget = extraEyeCount == 0 ? WordmarkStyle.maximumExtraEyeCount : 0
        }

        toggleTargetEyeCount = nextTarget
        eyeSequenceID += 1
    }

    @MainActor
    private func wait(milliseconds: Int) async -> Bool {
        do {
            try await Task.sleep(for: .milliseconds(milliseconds))
            return !Task.isCancelled
        } catch {
            return false
        }
    }

    @MainActor
    private func transitionEyes(to count: Int, animation: Animation) {
        haptics.play(.soft(intensity: 0.6))
        withAnimation(animation) {
            extraEyeCount = count
        }
    }
}

private struct WordmarkI: View {
    var body: some View {
        // The dotless glyph lets the lavender brand dot animate independently.
        Text("\u{0131}")
            .overlay(alignment: .top) {
                Circle()
                    .fill(WordmarkStyle.dotColor)
                    .frame(width: WordmarkStyle.dotSize, height: WordmarkStyle.dotSize)
                    .offset(y: WordmarkStyle.dotVerticalOffset)
            }
    }
}

private enum WordmarkStyle {
    static let schoolbellFontName = "Schoolbell-Regular"
    static let machinesFontName = "DMSerifDisplay-Regular"
    static let myFontSize: CGFloat = 50
    static let machinesFontSize: CGFloat = 55
    static let maximumExtraEyeCount = 4
    static let spacing: CGFloat = 4
    static let dotSize: CGFloat = 10
    static let dotVerticalOffset: CGFloat = 14
    static let dotColor = Color(hex: 0xD4A8FF)
}
