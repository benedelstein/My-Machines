import SwiftUI

/// Full-width primary action styling shared by feature screens.
struct MainButtonStyle: ButtonStyle {
    enum Variant {
        case filled
        case outline
    }

    @Environment(\.isEnabled) private var isEnabled: Bool
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let variant: Variant
    let isLoading: Bool

    func makeBody(configuration: Configuration) -> some View {
        let shape = Capsule()

        ZStack {
            configuration.label
                .opacity(isLoading ? 0 : 1)

            if isLoading {
                ProgressView()
                    .tint(foregroundColor)
            }
        }
        .font(style.headlineFont)
        .foregroundStyle(foregroundColor)
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity)
        .frame(height: style.mainButtonHeight)
        .background(shape.fill(backgroundColor))
        .overlay(shape.stroke(outlineColor, lineWidth: style.outlineThickness))
        .contentShape(shape)
        .scaleEffect(configuration.isPressed && !isLoading ? 0.96 : 1)
        .animation(style.springAnimation, value: configuration.isPressed)
        .allowsHitTesting(!isLoading)
    }

    private var isVisuallyEnabled: Bool {
        isEnabled || isLoading
    }

    private var backgroundColor: Color {
        switch variant {
        case .filled:
            isVisuallyEnabled ? theme.labelColor : theme.disabledBackgroundColor
        case .outline:
            theme.backgroundColor
        }
    }

    private var outlineColor: Color {
        switch variant {
        case .filled:
            .clear
        case .outline:
            isVisuallyEnabled ? theme.labelColor : theme.disabledBackgroundColor
        }
    }

    private var foregroundColor: Color {
        switch variant {
        case .filled:
            theme.backgroundColor
        case .outline:
            isVisuallyEnabled ? theme.labelColor : theme.disabledBackgroundColor
        }
    }
}

extension ButtonStyle where Self == MainButtonStyle {
    static func main(
        variant: MainButtonStyle.Variant = .filled,
        isLoading: Bool = false
    ) -> Self {
        MainButtonStyle(variant: variant, isLoading: isLoading)
    }
}
