import SwiftUI
import UIKit

/// Shared copyable container chrome for transcript and tool-detail code previews.
struct CodePreviewChrome<Content: View>: View {
    enum Background {
        case primary
        case secondary

        func color(in theme: Theme) -> Color {
            switch self {
            case .primary:
                theme.backgroundColor
            case .secondary:
                theme.secondaryBackgroundColor
            }
        }
    }

    @Environment(\.theme) private var theme
    @Environment(\.style) private var style
    @Environment(\.showToast) private var showToast
    @Environment(\.hapticFeedbackPlayer) private var haptics

    private let text: String
    private let copyAccessibilityLabel: String
    private let background: Background
    private let title: String?
    private let content: Content

    /// Creates chrome with an optional title row above the content and a copy affordance.
    init(
        text: String,
        copyAccessibilityLabel: String,
        background: Background,
        title: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.text = text
        self.copyAccessibilityLabel = copyAccessibilityLabel
        self.background = background
        self.title = title
        self.content = content()
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 0) {
                if let title, !title.isEmpty {
                    Text(title)
                        .font(style.caption2Font.bold())
                        .foregroundStyle(theme.labelColor)
                        .padding(.horizontal, style.gridSize)
                        .padding(.vertical, style.gridSize)
                }
                content
            }

            Button(action: copyText) {
                Image(systemName: "square.on.square")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(theme.secondaryLabelColor)
                    .padding(6)
                    .contentShape(Rectangle())
                    .background(
                        RoundedRectangle(cornerRadius: 6).fill(theme.secondaryBackgroundColor)
                    )
            }
            .buttonStyle(.highlight)
            .accessibilityLabel(copyAccessibilityLabel)
            .padding(style.gridSize / 2)
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(background.color(in: theme))
        )
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func copyText() {
        UIPasteboard.general.string = text
        haptics.play(.light)
        showToast?(title: "Copied", icon: Image(systemName: "doc.on.doc"))
    }
}
