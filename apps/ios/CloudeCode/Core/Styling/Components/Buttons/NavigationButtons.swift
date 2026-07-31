import SwiftUI

struct GlassButton: View {
    @Environment(\.theme) private var theme: Theme

    var systemImage: String
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(theme.labelColor)
                .frame(width: 40, height: 40)
                .glassBackground(in: Circle())
                .contentShape(Circle())
        }
        .disabled(isDisabled)
    }
}

struct CloseButton: View {
    @Environment(\.theme) private var theme: Theme

    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        GlassButton(systemImage: "xmark", isDisabled: isDisabled, action: action)
            .accessibilityLabel("Close")
    }
}

struct BackButton: View {
    @Environment(\.theme) private var theme: Theme

    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        GlassButton(systemImage: "arrow.left", isDisabled: isDisabled, action: action)
        .accessibilityLabel("Back")
    }
}

struct ToolbarCloseButton: ToolbarContent {
    @Environment(\.theme) private var theme: Theme

    var placement: ToolbarItemPlacement = .topBarLeading
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: placement) {
            Button(action: action) {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.labelColor)
                    .contentShape(Rectangle().inset(by: -5))
            }
            .disabled(isDisabled)
            .accessibilityLabel("Close")
        }
    }
}

struct ToolbarBackButton: ToolbarContent {
    @Environment(\.theme) private var theme: Theme

    var placement: ToolbarItemPlacement = .topBarLeading
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: placement) {
            Button(action: action) {
                Image(systemName: "arrow.left")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.labelColor)
                    .contentShape(Rectangle().inset(by: -5))
            }
            .disabled(isDisabled)
            .accessibilityLabel("Back")
        }
    }
}
