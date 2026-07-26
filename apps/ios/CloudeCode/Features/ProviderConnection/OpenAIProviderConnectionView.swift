import CoreAPI
import Domain
import SwiftUI
import UIKit

/// Native OpenAI Codex device-code connection screen.
struct OpenAIProviderConnectionView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.showToast) private var showToast
    @Environment(\.style) private var style
    @Environment(\.theme) private var theme
    @Environment(\.hapticFeedbackPlayer) var haptics

    @State var viewModel: OpenAIProviderConnectionViewModel
    let onConnected: () -> Void

    @State private var openTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 24) {
                hero

                authorizationContent(viewModel.authorization)

                if let errorMessage = viewModel.errorMessage {
                    error(message: errorMessage)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 24)

            securityCallout
                .padding(.top, 32)

            actionArea
                .padding(.top, 16)
        }
        .padding(.horizontal, style.horizontalPadding)
        .onAppear {
            viewModel.load()
        }
        .animation(.default, value: viewModel.phase)
        .onChange(of: viewModel.isConnected) { _, isConnected in
            guard isConnected else { return }
            onConnected()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            viewModel.sceneDidBecomeActive()
        }
        .onDisappear {
            openTask?.cancel()
            viewModel.unload()
        }
    }

    private var hero: some View {
        ProviderConnectionHeroView(
            providerId: .openaiCodex,
            title: isReconnect ? "Reconnect Codex" : "Sign in with ChatGPT",
            subtitle: heroSubtitle
        )
    }

    private var heroSubtitle: LocalizedStringKey {
        if viewModel.authorization != nil {
            return isReconnect
                ? "Copy this code, then continue to ChatGPT to reconnect Codex."
                : "Copy this code, then continue to ChatGPT to authorize the connection."
        }
        if isReconnect {
            return "Your OpenAI Codex session expired. Reconnect to continue using Codex models."
        }
        return "Connect your OpenAI account to use Codex models in My Machines."
    }

    private var isReconnect: Bool {
        viewModel.context.requiresReauth || viewModel.context.sessionId != nil
    }

    private var securityCallout: some View {
        CalloutView(tint: theme.accentOrange, systemImage: "exclamationmark.triangle") {
            Text(securityMessage)
                .tint(theme.accentOrange)
        }
    }

    private var securityMessage: AttributedString {
        var message = AttributedString("Device-code authentication must be enabled in ChatGPT Security settings.")
        guard let range = message.range(of: "ChatGPT Security settings") else {
            return message
        }
        message[range].link = Self.securitySettingsURL
        message[range].underlineStyle = Text.LineStyle(pattern: .solid)
        return message
    }

    private func authorizationContent(_ authorization: OpenAIDeviceAuthorization?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CODE")
                .font(style.caption2Font.weight(.semibold))
                .foregroundStyle(theme.secondaryLabelColor)

            HStack(spacing: 12) {
                Text(verbatim: authorization?.userCode ?? "XXXX-XXXX")
                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .minimumScaleFactor(0.8)
                    .redacted(reason: authorization == nil ? [.placeholder] : [])

                Spacer(minLength: 0)

                Button {
                    guard let authorization else { return }
                    haptics.play(.light)
                    copy(authorization, openingChatGPT: false)
                } label: {
                    Image(systemName: "square.on.square")
                        .font(style.subheadlineFont.weight(.semibold))
                }
                .disabled(authorization == nil)
                .buttonStyle(.highlight)
                .redacted(reason: authorization == nil ? [.placeholder] : [])
            }

            if viewModel.isWaiting {
                Divider()

                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Waiting for authorization…")
                        .font(style.subheadlineFont)
                        .foregroundStyle(theme.secondaryLabelColor)
                }
                .transition(.opacity)
            }
        }
        .padding(16)
        .background(theme.secondaryBackgroundColor, in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder
    private var actionArea: some View {
        VStack(spacing: 12) {
            if let authorization = viewModel.authorization {
                Button {
                    openChatGPT(authorization)
                } label: {
                    buttonLabel(
                        title: viewModel.isWaiting
                            ? "Copy and open ChatGPT again"
                            : isReconnect
                                ? "Copy and reconnect in ChatGPT"
                                : "Copy and continue to ChatGPT"
                    )
                }
                .buttonStyle(.main())
            } else {
                Button {
                    viewModel.load()
                } label: {
                    buttonLabel(title: viewModel.errorMessage == nil ? "Preparing code…" : "Try again")
                }
                .buttonStyle(.main(isLoading: viewModel.errorMessage == nil))
                .disabled(viewModel.errorMessage == nil)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func buttonLabel(title: LocalizedStringKey) -> some View {
        HStack(spacing: 8) {
            Image(.providerOpenai)
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: 17, height: 17)
            Text(title)
        }
    }

    private func openChatGPT(_ authorization: OpenAIDeviceAuthorization) {
        guard let url = URL(string: authorization.verificationURL) else { return }
        openTask?.cancel()
        haptics.play(.light)

        openTask = Task { @MainActor in
            copy(authorization, openingChatGPT: true)
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }

            openURL(url)
            viewModel.didOpenAuthorization()
            openTask = nil
        }
    }

    private func copy(
        _ authorization: OpenAIDeviceAuthorization,
        openingChatGPT: Bool
    ) {
        UIPasteboard.general.string = authorization.userCode
        showToast?(
            title: "Code copied",
            subtitle: openingChatGPT ? "Opening ChatGPT…" : "Paste it in ChatGPT to complete the authorizaton process.",
            icon: Image(systemName: "square.on.square")
        )
    }

    private func error(message: String) -> some View {
        CalloutView(tint: theme.errorRed, systemImage: "exclamationmark.circle") {
            Text(verbatim: message)
        }
    }

    private static let securitySettingsURL = URL(string: "https://chatgpt.com/#settings/Security")
}
