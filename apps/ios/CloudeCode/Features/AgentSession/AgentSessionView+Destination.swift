import CoreAPI
import SwiftUI

extension AgentSessionView {
    enum Destination: Identifiable, Equatable {
        case image(SessionImageInfo)
        case renderItem(AgentSessionRenderItem)
        case providerConnection(ProviderConnectionContext)

        var id: String {
            switch self {
            case .image(let image):
                "image_\(image.id)"
            case .renderItem(let item):
                item.key
            case .providerConnection(let context):
                "provider_connection_\(context.providerId.rawValue)"
            }
        }
    }

    struct Destinations: ViewModifier {
        @Environment(\.providerConnectionBuilder) private var providerConnectionBuilder
        @Environment(\.showToast) private var showToast
        @Environment(\.hapticFeedbackPlayer) private var haptics
        @Binding var destination: Modal<Destination>?
        let onProviderConnected: (ProviderConnectionContext) -> Void

        func body(content: Content) -> some View {
            content
                .withModal($destination) { destination in
                    switch destination {
                    case .image(let image):
                        FullscreenImageView(image: image)
                    case .renderItem(let item):
                        AgentSessionToolDetailSheet(item: item)
                            .presentationDetents([PresentationDetent.medium, PresentationDetent.large])
                            .presentationBackground(.clear)
                    case .providerConnection(let context):
                        if let providerConnectionBuilder {
                            providerConnectionBuilder.build(context: context) {
                                providerDidConnect(context)
                            }
                        } else {
                            ContentUnavailableView(
                                "Provider connection unavailable",
                                systemImage: "exclamationmark.triangle"
                            )
                        }
                    }
                }
        }

        private func providerDidConnect(_ context: ProviderConnectionContext) {
            onProviderConnected(context)
            destination = nil
            haptics.play(.success)
            showToast?(
                title: connectionSuccessTitle(for: context),
                icon: Image(systemName: "checkmark.circle.fill")
            )
        }

        private func connectionSuccessTitle(for context: ProviderConnectionContext) -> Text {
            switch context.providerId {
            case .claudeCode:
                Text("Claude connected")
            case .openaiCodex:
                Text("Codex connected")
            case .unknown:
                Text(verbatim: "\(context.providerName) connected")
            }
        }
    }
}
