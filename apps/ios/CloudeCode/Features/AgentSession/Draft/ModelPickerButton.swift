import CoreAPI
import Domain
import SwiftUI

struct ModelPickerButton: View {
    @Environment(\.composerStyle) var composerStyle: ComposerStyle
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let modelCatalog: ModelCatalogStore
    let selectedModel: ModelSelection?
    let providerId: ProviderId?
    let providerConnection: SessionClientState.ProviderConnection?
    let restrictsProvider: Bool
    let isLoadingSelection: Bool
    let onSelectModel: (ProviderCatalogEntry, ProviderCatalogModel) -> Void
    let onSelectEffort: (ProviderCatalogEntry, ProviderCatalogEffort) -> Void
    let onConnectProvider: (ProviderCatalogEntry) -> Void
    @State private var isSheetPresented: Bool = false
    @State private var pendingConnectionProvider: ProviderCatalogEntry?

    var body: some View {
        pickerControl
            .buttonStyle(.plain)
            .disabled(isLoadingSelection)
            .redacted(reason: isLoadingSelection ? .placeholder : [])
            .sheet(isPresented: $isSheetPresented, onDismiss: presentPendingConnection) {
                ModelPickerSheet(
                    modelCatalog: modelCatalog,
                    selectedModel: displayedModel,
                    providerId: providerId,
                    restrictsProvider: restrictsProvider,
                    onSelectModel: onSelectModel,
                    onConnectProvider: requestProviderConnection
                )
            }
    }

    @ViewBuilder
    private var pickerControl: some View {
        if let displayedModel {
            if isProviderConnectionRequired {
                Button {
                    presentProviderConnection()
                } label: {
                    menuLabel
                }
                .accessibilityLabel(providerConnectionActionTitle)
            } else {
                Menu {
                    Section("Model") {
                        Button {
                            presentModelPicker()
                        } label: {
                            Text(displayedModel.displayName)
                        }
                    }

                    Section("Effort Level") {
                        effortMenu
                    }
                } label: {
                    menuLabel
                }
                .menuIndicator(.hidden)
            }
        } else {
            Button {
                isSheetPresented = true
            } label: {
                menuLabel
            }
        }
    }

    @ViewBuilder
    private var effortMenu: some View {
        if let provider = selectedProvider {
            Menu(displayedModel?.effortDisplayName ?? "Select an effort level") {
                ForEach(provider.efforts, id: \.id) { effort in
                    Button {
                        onSelectEffort(provider, effort)
                    } label: {
                        if displayedModel?.effortId == effort.id {
                            Label(effort.displayName, systemImage: "checkmark")
                        } else {
                            Text(effort.displayName)
                        }
                    }
                    .disabled(!effort.selectable)
                }
            }
        } else {
            Button("Select an effort level") {}
                .disabled(true)
        }
    }

    private var menuLabel: some View {
        HStack(spacing: style.gridSize * 0.75) {
            if let model = displayedModel {
                ProviderIconView(providerId: model.providerId)
                    .frame(width: 16, height: 16)
                Text(model.displayName)
                    .lineLimit(1)
                if isProviderConnectionRequired {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(theme.accentOrange)
                        .accessibilityHidden(true)
                }
            } else {
                Image(systemName: "cpu")
                Text("Select model")
                    .lineLimit(1)
            }
        }
        .styledFont(.caption)
        .foregroundStyle(theme.labelColor)
        .padding(.horizontal, 12)
        .frame(height: composerStyle.bottomButtonSize)
        .contentShape(Capsule())
        .glassBackground(in: Capsule())
    }

    private var selectedProvider: ProviderCatalogEntry? {
        guard let displayedModel else {
            return nil
        }
        return modelCatalog.catalog?.providers.first {
            $0.providerId == displayedModel.providerId
        }
    }

    private var isProviderConnectionRequired: Bool {
        guard let displayedModel,
              let providerConnection,
              ProviderId(rawValue: providerConnection.provider) == displayedModel.providerId else {
            return false
        }
        return !providerConnection.connected
    }

    private var providerConnectionActionTitle: Text {
        let providerName = selectedProvider?.providerName ?? "provider"
        return providerConnection?.requiresReauth == true
            ? Text("Reconnect \(providerName)")
            : Text("Connect \(providerName)")
    }

    private var displayedModel: ModelSelection? {
        guard let selectedModel,
              !restrictsProvider || selectedModel.providerId == providerId else {
            return nil
        }
        return selectedModel
    }

    private func presentModelPicker() {
        Task { @MainActor in
            // Let the menu finish dismissing before asking SwiftUI to present a sheet.
            try? await Task.sleep(for: .milliseconds(100))
            isSheetPresented = true
        }
    }

    private func presentProviderConnection() {
        guard var provider = selectedProvider else {
            isSheetPresented = true
            return
        }
        provider.connected = providerConnection?.connected ?? provider.connected
        provider.requiresReauth = providerConnection?.requiresReauth ?? provider.requiresReauth
        onConnectProvider(provider)
    }

    private func requestProviderConnection(_ provider: ProviderCatalogEntry) {
        Logger.info("Provider connection requested from model picker: \(provider.providerId.rawValue)")
        pendingConnectionProvider = provider
        isSheetPresented = false
    }

    private func presentPendingConnection() {
        guard let provider = pendingConnectionProvider else { return }
        Logger.info("Model picker dismissed; forwarding provider connection: \(provider.providerId.rawValue)")
        pendingConnectionProvider = nil
        onConnectProvider(provider)
    }
}
