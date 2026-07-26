import SwiftUI
import UIKit

extension PromptComposerView {
    struct Editor: View {
        @Environment(\.theme) private var theme: Theme

        @Binding var text: String
        var focused: Binding<Bool>
        let placeholder: String

        var body: some View {
            GrowingTextView(
                text: $text,
                focused: focused,
                font: EditorStyle.font,
                textColor: UIColor(theme.labelColor),
                textInsets: EditorStyle.textInsets,
                maxVisibleLines: EditorStyle.maxVisibleLines
            )
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .overlay(alignment: .topLeading) {
                placeholderView
            }
        }

        @ViewBuilder
        private var placeholderView: some View {
            if text.isEmpty {
                Text(placeholder)
                    .styledFont(.body)
                    .foregroundStyle(theme.tertiaryLabelColor)
                    .padding(.top, EditorStyle.textInsets.top)
                    .padding(.leading, EditorStyle.textInsets.left)
                    .allowsHitTesting(false)
            }
        }
    }

    private enum EditorStyle {
        static var font: UIFont { UIFont.systemFont(ofSize: 17, weight: .regular) }
        static var horizontalInset: CGFloat { 16 }
        static var topInset: CGFloat { 16 }
        static var maxVisibleLines: Int { 6 }

        static var textInsets: UIEdgeInsets {
            UIEdgeInsets(
                top: topInset,
                left: horizontalInset,
                bottom: 4,
                right: horizontalInset
            )
        }
    }

    private enum SendButtonState: Equatable {
        case send(isLoading: Bool)
        case stop(isLoading: Bool)
    }

    struct SendButton: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.hapticFeedbackPlayer) private var haptics

        let isSubmitDisabled: Bool
        let isSubmitting: Bool
        let isResponding: Bool
        let isCancelling: Bool
        let isInterruptDisabled: Bool
        let size: CGFloat
        let onSubmit: () -> Void
        let onStop: () -> Void

        private var showsStop: Bool {
            (isCancelling || (isResponding && !isInterruptDisabled)) && !isSubmitting
        }

        private var state: SendButtonState {
            if showsStop {
                return .stop(isLoading: isCancelling)
            }
            return .send(isLoading: isSubmitting)
        }

        var body: some View {
            Button {
                haptics.play(.light)
                if showsStop {
                    onStop()
                } else {
                    onSubmit()
                }
            } label: {
                ZStack {
                    switch state {
                    case .send(let isLoading):
                        SendButtonFace(
                            color: sendButtonColor,
                            symbolName: "arrow.up",
                            symbolFont: .system(size: 16, weight: .semibold),
                            isLoading: isLoading
                        )
                        .transition(.scale)
                    case .stop(let isLoading):
                        SendButtonFace(
                            color: theme.errorRed,
                            symbolName: "square.fill",
                            symbolFont: .system(size: 12, weight: .semibold),
                            isLoading: isLoading
                        )
                        .transition(.scale)
                    }
                }
                .frame(width: size, height: size)
                .animation(.easeInOut(duration: 0.15), value: showsStop)
            }
            .buttonStyle(.bounce(0.95))
            .disabled(isButtonDisabled)
            .accessibilityLabel(accessibilityLabel)
        }

        private var sendButtonColor: Color {
            isSubmitDisabled ? .gray : theme.accentBlue
        }

        private var isButtonDisabled: Bool {
            showsStop
                ? isCancelling || isInterruptDisabled
                : isSubmitDisabled || isSubmitting
        }

        private var accessibilityLabel: String {
            if isCancelling {
                return "Stopping response"
            }
            if showsStop {
                return isInterruptDisabled ? "Response cannot be stopped yet" : "Stop response"
            }
            return "Send"
        }
    }

    private struct SendButtonFace: View {
        let color: Color
        let symbolName: String
        let symbolFont: Font
        let isLoading: Bool

        var body: some View {
            ZStack {
                Circle()
                    .fill(color)

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                        .transition(.scale)
                } else {
                    Image(systemName: symbolName)
                        .font(symbolFont)
                        .foregroundStyle(.white)
                        .transition(.scale)
                }
            }
            .animation(.easeInOut(duration: 0.15), value: isLoading)
        }
    }
}
