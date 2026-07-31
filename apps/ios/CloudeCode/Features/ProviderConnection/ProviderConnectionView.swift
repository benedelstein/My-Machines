import SwiftUI

/// Native sheet chrome shared by provider-specific connection screens.
struct ProviderConnectionView<Content: View>: View {
    @Environment(\.theme) private var theme: Theme

    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 16)
            .selfSizingSheet(
                initialHeightEstimate: 420,
                extraDetents: []
            )
//            .background(theme.secondaryBackgroundColor)
//            .presentationBackground(theme.secondaryBackgroundColor)
            .presentationDragIndicator(.visible)
    }
}
