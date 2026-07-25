import API
import CoreAPI
import Domain
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hapticFeedbackPlayer) private var haptics
    @Environment(\.showToast) private var showToast
    @State private var isConfirmingSignOut = false
    @State private var isConfirmingDisconnect = false
    @State private var pendingDisconnect: SettingsViewModel.Provider?
    @State private var connectionRequest: ConnectionRequest?
    @State private var viewModel: SettingsViewModel

    let logStore: AppLogStore
    let sessionStore: SessionStore

    init(
        logStore: AppLogStore,
        sessionStore: SessionStore,
        providerAuthAPI: any ProviderAuthAPIProviding,
        modelCatalogStore: ModelCatalogStore
    ) {
        self.logStore = logStore
        self.sessionStore = sessionStore
        _viewModel = State(initialValue: SettingsViewModel(
            providerAuthAPI: providerAuthAPI,
            modelCatalogStore: modelCatalogStore
        ))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(SettingsViewModel.Provider.allCases) { provider in
                        ProviderConnectionRow(
                            provider: provider,
                            state: viewModel.connectionState(for: provider),
                            onConnect: { connect(provider) },
                            onDisconnect: { confirmDisconnect(provider) },
                            onRetry: viewModel.retryLoading
                        )
                    }
                } header: {
                    Text("Provider Connections")
                }

                Section {
                    NavigationLink {
                        LogsView(logStore: logStore)
                    } label: {
                        Label("Logs", systemImage: "doc.text.magnifyingglass")
                    }
                } header: {
                    Text("Diagnostics")
                } footer: {
                    Text("Recent app logs are kept in memory for debugging.")
                }

                Section {
                    Button(role: .destructive) {
                        isConfirmingSignOut = true
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .tint(.red)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Account")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .toolbar {
                ToolbarCloseButton {
                    dismiss()
                }
            }
            .onAppear {
                viewModel.load()
            }
            .onDisappear {
                viewModel.unload()
            }
            .onChange(of: viewModel.notice) { _, notice in
                guard let notice else { return }
                handle(notice)
            }
            .sheet(item: $connectionRequest) { request in
                providerConnection(for: request.provider)
            }
            .alert(
                pendingDisconnect.map { "Disconnect \($0.displayName)?" } ?? "Disconnect provider?",
                isPresented: $isConfirmingDisconnect,
                presenting: pendingDisconnect
            ) { provider in
                Button("Disconnect", role: .destructive) {
                    viewModel.disconnect(provider)
                    pendingDisconnect = nil
                }
                Button("Cancel", role: .cancel) {
                    pendingDisconnect = nil
                }
            } message: { provider in
                Text("You won't be able to use \(provider.displayName) models until you reconnect.")
            }
            .alert("Sign out?", isPresented: $isConfirmingSignOut) {
                Button("Sign out", role: .destructive) {
                    dismiss()
                    Task {
                        await sessionStore.signOut()
                    }
                }
            }
        }
    }

    private func connect(_ provider: SettingsViewModel.Provider) {
        connectionRequest = ConnectionRequest(provider: provider)
    }

    private func confirmDisconnect(_ provider: SettingsViewModel.Provider) {
        pendingDisconnect = provider
        isConfirmingDisconnect = true
    }

    @ViewBuilder
    private func providerConnection(for provider: SettingsViewModel.Provider) -> some View {
        let context = ProviderConnectionContext(
            providerId: provider.providerId,
            providerName: viewModel.catalogEntry(for: provider)?.providerName ?? provider.displayName,
            requiresReauth: viewModel.catalogEntry(for: provider)?.requiresReauth ?? false,
            sessionId: nil
        )

        ProviderConnectionView {
            switch provider {
            case .claude:
                ClaudeProviderConnectionView(
                    viewModel: ClaudeProviderConnectionViewModel(
                        context: context,
                        api: viewModel.providerAuthAPI,
                        modelCatalogStore: viewModel.modelCatalogStore
                    )
                ) {
                    providerDidConnect(provider)
                }
            case .codex:
                OpenAIProviderConnectionView(
                    viewModel: OpenAIProviderConnectionViewModel(
                        context: context,
                        api: viewModel.providerAuthAPI,
                        modelCatalogStore: viewModel.modelCatalogStore
                    )
                ) {
                    providerDidConnect(provider)
                }
            }
        }
    }

    private func providerDidConnect(_ provider: SettingsViewModel.Provider) {
        connectionRequest = nil
        haptics.play(.success)
        showToast?(
            title: Text(verbatim: "\(provider.connectedToastName) connected"),
            icon: Image(systemName: "checkmark.circle.fill")
        )
    }

    private func handle(_ notice: SettingsViewModel.Notice) {
        switch notice.kind {
        case .disconnected:
            haptics.play(.success)
            showToast?(
                title: Text(verbatim: notice.message),
                icon: Image(systemName: "checkmark.circle.fill")
            )
        case .error:
            haptics.play(.error)
            showToast?(
                title: Text("Failed to disconnect provider"),
                verbatimSubtitle: notice.message,
                icon: Image(systemName: "exclamationmark.circle.fill")
            )
        }
    }

    private struct ConnectionRequest: Identifiable {
        let id = UUID()
        let provider: SettingsViewModel.Provider
    }
}

private extension SettingsView {
    struct ProviderConnectionRow: View {
        @Environment(\.style) private var style
        @Environment(\.theme) private var theme

        let provider: SettingsViewModel.Provider
        let state: SettingsViewModel.ConnectionState
        let onConnect: () -> Void
        let onDisconnect: () -> Void
        let onRetry: () -> Void

        var body: some View {
            HStack(spacing: 12) {
                ProviderIconView(providerId: provider.providerId)
                    .frame(width: 22, height: 22)
                    .padding(7)
                    .foregroundStyle(theme.labelColor)
                    .background(theme.secondaryBackgroundColor, in: RoundedRectangle(cornerRadius: 10))

                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.displayName)
                        .font(style.bodyFont)

                    Text(statusTitle)
                        .font(style.captionFont)
                        .foregroundStyle(statusColor)
                }

                Spacer(minLength: 12)

                action
            }
            .padding(.vertical, 4)
        }

        @ViewBuilder
        private var action: some View {
            switch state {
            case .checking:
                ProgressView()
                    .controlSize(.small)
            case .disconnecting:
                ProgressView()
                    .controlSize(.small)
            case .connected:
                actionButton("Disconnect", role: .destructive, action: onDisconnect)
            case .reconnectRequired:
                actionButton("Reconnect", action: onConnect)
            case .notConnected:
                actionButton("Connect", action: onConnect)
            case .unavailable:
                actionButton("Retry", action: onRetry)
            }
        }

        private var statusTitle: LocalizedStringResource {
            switch state {
            case .checking:
                "Checking…"
            case .connected:
                "Connected"
            case .reconnectRequired:
                "Reconnect required"
            case .notConnected:
                "Not connected"
            case .unavailable:
                "Unavailable"
            case .disconnecting:
                "Disconnecting…"
            }
        }

        private var statusColor: Color {
            switch state {
            case .connected:
                .green
            case .reconnectRequired, .unavailable:
                .orange
            case .checking, .notConnected, .disconnecting:
                theme.secondaryLabelColor
            }
        }

        private func actionButton(
            _ title: LocalizedStringResource,
            role: ButtonRole? = nil,
            action: @escaping () -> Void
        ) -> some View {
            Button(role: role, action: action) {
                Text(title)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }
}

private struct LogsView: View {
    @Environment(\.theme) private var theme
    @Environment(\.style) private var style
    @Environment(\.showToast) var showToast: ShowToastAction?

    let logStore: AppLogStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: style.gridSize) {
                if logStore.entries.isEmpty {
                    EmptyStateView(title: "No logs yet") {
                        Image(systemName: "doc.text")
                    }
                    .frame(maxWidth: .infinity, minHeight: style.gridSize * 24)
                } else {
                    ForEach(logStore.entries) { entry in
                        LogRow(entry: entry)
                    }
                }
            }
            .padding(style.horizontalPadding)
        }
        .background(theme.backgroundColor)
        .navigationTitle("Logs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Copy") {
                    showToast?(
                        title: "Copied logs to clipboard",
                        icon: Image(systemName: "square.on.square")
                    )
                    UIPasteboard.general.string = logStore.exportText
                }
                .disabled(logStore.entries.isEmpty)
            }
        }
    }
}

private struct LogRow: View {
    @Environment(\.theme) private var theme
    @Environment(\.style) private var style

    let entry: AppLogRecord

    var body: some View {
        VStack(alignment: .leading, spacing: style.gridSize / 2) {
            HStack(spacing: style.gridSize) {
                Text(entry.level.rawValue)
                    .font(style.captionFont.weight(.semibold))
                    .foregroundStyle(levelColor)

                Text(entry.displayTime)
                    .styledFont(.caption)
                    .foregroundStyle(theme.secondaryLabelColor)

                Spacer(minLength: style.gridSize)
            }

            Text(entry.message)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(theme.labelColor)
                .textSelection(.enabled)

            Text(entry.location)
                .styledFont(.caption)
                .foregroundStyle(theme.secondaryLabelColor)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(style.gridSize)
        .background(theme.secondaryBackgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: style.gridSize, style: .continuous))
    }

    private var levelColor: Color {
        switch entry.level {
        case .debug:
            theme.secondaryLabelColor
        case .info:
            theme.accentBlue
        case .warning:
            .orange
        case .error:
            theme.errorRed
        }
    }
}
