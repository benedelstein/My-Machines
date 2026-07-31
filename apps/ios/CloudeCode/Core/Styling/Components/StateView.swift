import SwiftUI

/// A reusable, app-styled state for content that has no items to display.
struct EmptyStateView<Icon: View, Action: View>: View {
    let title: LocalizedStringResource
    private let subtitle: StateViewText?
    private let icon: () -> Icon
    private let action: () -> Action

    init(
        title: LocalizedStringResource,
        subtitle: LocalizedStringResource? = nil,
        @ViewBuilder icon: @escaping () -> Icon,
        @ViewBuilder action: @escaping () -> Action
    ) {
        self.title = title
        self.subtitle = subtitle.map(StateViewText.localized)
        self.icon = icon
        self.action = action
    }

    var body: some View {
        StateViewLayout(title: title, subtitle: subtitle, icon: icon, action: action)
    }
}

/// A reusable, app-styled state for content that could not be loaded or displayed.
struct ErrorStateView<Icon: View, Action: View>: View {
    let title: LocalizedStringResource
    private let subtitle: StateViewText?
    private let icon: () -> Icon
    private let action: () -> Action

    init(
        title: LocalizedStringResource,
        subtitle: LocalizedStringResource? = nil,
        @ViewBuilder icon: @escaping () -> Icon,
        @ViewBuilder action: @escaping () -> Action
    ) {
        self.title = title
        self.subtitle = subtitle.map(StateViewText.localized)
        self.icon = icon
        self.action = action
    }

    init(
        title: LocalizedStringResource,
        verbatimSubtitle: String,
        @ViewBuilder icon: @escaping () -> Icon,
        @ViewBuilder action: @escaping () -> Action
    ) {
        self.title = title
        self.subtitle = .verbatim(verbatimSubtitle)
        self.icon = icon
        self.action = action
    }

    var body: some View {
        StateViewLayout(title: title, subtitle: subtitle, icon: icon, action: action)
    }
}

extension EmptyStateView where Action == EmptyView {
    init(
        title: LocalizedStringResource,
        subtitle: LocalizedStringResource? = nil,
        @ViewBuilder icon: @escaping () -> Icon
    ) {
        self.init(title: title, subtitle: subtitle, icon: icon) {
            EmptyView()
        }
    }
}

extension ErrorStateView where Action == EmptyView {
    init(
        title: LocalizedStringResource,
        subtitle: LocalizedStringResource? = nil,
        @ViewBuilder icon: @escaping () -> Icon
    ) {
        self.init(title: title, subtitle: subtitle, icon: icon) {
            EmptyView()
        }
    }

    init(
        title: LocalizedStringResource,
        verbatimSubtitle: String,
        @ViewBuilder icon: @escaping () -> Icon
    ) {
        self.init(
            title: title,
            verbatimSubtitle: verbatimSubtitle,
            icon: icon
        ) {
            EmptyView()
        }
    }
}

/// A compact primary action designed for use inside an empty or error state.
struct StatePillButton: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let title: LocalizedStringResource
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(style.subheadlineFont.weight(.bold))
                .foregroundStyle(.white)
                .frame(height: 36)
                .padding(.horizontal, style.spacing)
                .background(Capsule().fill(theme.accentBlue))
        }
        .buttonStyle(.plain)
    }
}

private struct StateViewLayout<Icon: View, Action: View>: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let title: LocalizedStringResource
    let subtitle: StateViewText?
    let icon: () -> Icon
    let action: () -> Action

    var body: some View {
        VStack(spacing: style.spacing) {
            ZStack {
                Circle()
                    .fill(theme.tertiaryBackgroundColor)
                    .frame(width: 88, height: 88)

                icon()
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabelColor)
                    .accessibilityHidden(true)
            }

            VStack(spacing: style.gridSize / 2) {
                Text(title)
                    .font(style.headlineFont)
                    .foregroundStyle(theme.labelColor)

                if let subtitle {
                    subtitle.text
                        .font(style.subheadlineFont)
                        .foregroundStyle(theme.secondaryLabelColor)
                }
            }
            .multilineTextAlignment(.center)

            action()
        }
        .padding(.horizontal, style.spacing * 2)
        .frame(maxWidth: .infinity)
    }
}

private enum StateViewText {
    case localized(LocalizedStringResource)
    case verbatim(String)

    var text: Text {
        switch self {
        case .localized(let resource):
            Text(resource)
        case .verbatim(let value):
            Text(verbatim: value)
        }
    }
}
