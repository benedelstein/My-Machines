import SwiftUI

/// Capsule chip label shared by the draft composer's picker buttons.
struct PickerChipLabel: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let icon: ImageResource
    let title: String
    let maxTitleWidth: CGFloat

    var body: some View {
        HStack(spacing: style.gridSize) {
            Image(icon)
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 16, height: 16)

            Text(title)
                .styledFont(.caption)
                .foregroundStyle(theme.labelColor)
                .lineLimit(1)
                .frame(maxWidth: maxTitleWidth, alignment: .leading)
                .fixedSize()
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .contentShape(Capsule())
        .glassBackground(in: Capsule())
    }
}
