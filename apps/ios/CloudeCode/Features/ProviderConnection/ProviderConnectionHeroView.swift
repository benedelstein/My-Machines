import CoreAPI
import SwiftUI

/// Shared provider identity and introductory copy for connection screens.
struct ProviderConnectionHeroView: View {
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let providerId: ProviderId
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey

    var body: some View {
        VStack(spacing: 16) {
            ProviderIconView(providerId: providerId)
                .frame(width: 44, height: 44)
                .padding(14)
                .background(theme.secondaryBackgroundColor, in: RoundedRectangle(cornerRadius: 20))

            VStack(spacing: 6) {
                Text(title)
                    .font(style.title2Font.weight(.semibold))

                Text(subtitle)
                    .font(style.subheadlineFont)
                    .foregroundStyle(theme.secondaryLabelColor)
                    .multilineTextAlignment(.center)
            }
        }
    }
}
