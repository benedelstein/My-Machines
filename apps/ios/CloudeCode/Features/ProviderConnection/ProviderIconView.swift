import CoreAPI
import SwiftUI

struct ProviderIconView: View {
    let providerId: ProviderId

    var body: some View {
        providerImage
            .scaledToFit()
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var providerImage: some View {
        switch providerId {
        case .claudeCode:
            Image(.providerAnthropic)
                .resizable()
                .renderingMode(.original)
        case .openaiCodex:
            Image(.providerOpenai)
                .resizable()
                .renderingMode(.template)
        case .unknown:
            Image(systemName: "cpu")
                .resizable()
        }
    }
}
