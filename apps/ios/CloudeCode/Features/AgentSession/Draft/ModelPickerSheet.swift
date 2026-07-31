import CoreAPI
import SwiftUI

struct ModelPickerSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let modelCatalog: ModelCatalogStore
    let selectedModel: ModelSelection?
    let providerId: ProviderId?
    let restrictsProvider: Bool
    let onSelectModel: (ProviderCatalogEntry, ProviderCatalogModel) -> Void
    let onConnectProvider: (ProviderCatalogEntry) -> Void
    @State private var query: String = ""
    @State private var collapsedProviderIDs: Set<String> = Set<String>()

    var body: some View {
        NavigationStack {
            List {
                if let catalog = modelCatalog.catalog {
                    let providers = filteredProviders(in: catalog)
                    if providers.isEmpty {
                        EmptyStateView(
                            title: "No models found",
                            subtitle: "Try a different search."
                        ) {
                            Image(systemName: "cpu")
                        }
                        .listRowBackground(Color.clear)
                    } else {
                        ForEach(providers, id: \.providerId.rawValue) { provider in
                            providerSection(provider)
                        }
                    }
                } else if modelCatalog.isLoading {
                    loadingRows
                } else {
                    ErrorStateView(
                        title: "No models",
                        subtitle: "Model catalog is unavailable."
                    ) {
                        Image(systemName: "cpu")
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle("Select Model")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .automatic)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .presentationDetents([.medium, .large])
            // Self-heals after an earlier load failure; no-ops once loaded.
            .task {
                await modelCatalog.load()
            }
        }
    }

    private func providerSection(_ provider: ProviderCatalogEntry) -> some View {
        let isExpanded = isSearching || !collapsedProviderIDs.contains(provider.providerId.rawValue)

        return Section {
            if isExpanded {
                providerRows(provider, models: filteredModels(for: provider))
            }
        } header: {
            providerHeader(provider, isExpanded: isExpanded)
        }
    }

    private func providerRows(
        _ provider: ProviderCatalogEntry,
        models: [ProviderCatalogModel]
    ) -> some View {
        ForEach(models, id: \.id) { model in
            ModelRow(
                displayName: model.displayName,
                isSelected: selectedModel?.providerId == provider.providerId
                    && selectedModel?.modelId == model.id,
                isEnabled: provider.isSelectable && model.selectable
            ) {
                onSelectModel(provider, model)
                dismiss()
            }
        }
    }

    private var loadingRows: some View {
        Section {
            ForEach(0 ..< 6, id: \.self) { _ in
                ModelRow(
                    displayName: "Model display name",
                    isSelected: false,
                    isEnabled: false
                ) {}
                .redacted(reason: .placeholder)
            }
        } header: {
            Text(verbatim: "Provider name")
                .redacted(reason: .placeholder)
        }
    }

    private func providerHeader(_ provider: ProviderCatalogEntry, isExpanded: Bool) -> some View {
        HStack(spacing: style.gridSize) {
            Button {
                withAnimation {
                    toggleProvider(provider)
                }
            } label: {
                HStack(spacing: style.gridSize) {
                    // One constant image with a rotation and fixed width so
                    // toggling expansion never shifts the header layout.
                    Image(systemName: "chevron.right")
                        .font(style.captionFont.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 14)
                    ProviderIconView(providerId: provider.providerId)
                        .frame(width: 14, height: 14)
                    Text(provider.providerName)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

            Spacer(minLength: style.gridSize)

            providerConnectionAction(provider)
        }
    }

    @ViewBuilder
    private func providerConnectionAction(_ provider: ProviderCatalogEntry) -> some View {
        if !provider.isSelectable {
            if provider.providerId.supportsNativeConnection {
                Button(provider.requiresReauth ? "Reconnect" : "Connect") {
                    onConnectProvider(provider)
                }
                .font(style.footnoteFont.weight(.semibold))
                .foregroundStyle(theme.accentBlue)
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(theme.accentBlue.opacity(0.12), in: Capsule())
                .padding(.vertical, 8)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
                .accessibilityLabel(
                    Text(verbatim: provider.requiresReauth
                         ? "Reconnect \(provider.providerName)"
                         : "Connect \(provider.providerName)")
                )
            } else {
                Text("Not connected")
                    .font(style.captionFont)
                    .foregroundStyle(theme.tertiaryLabelColor)
            }
        }
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isSearching: Bool {
        !trimmedQuery.isEmpty
    }

    private func filteredProviders(in catalog: ModelsResponse) -> [ProviderCatalogEntry] {
        // The store pre-sorts providers (selectable first); only the selected
        // provider needs hoisting here because it depends on the selection.
        var providers = catalog.providers.filter { provider in
            (!restrictsProvider || provider.providerId == providerId)
                && !filteredModels(for: provider).isEmpty
        }
        if let selectedIndex = providers.firstIndex(where: {
            $0.providerId == selectedModel?.providerId
        }), selectedIndex > 0 {
            providers.insert(providers.remove(at: selectedIndex), at: 0)
        }
        return providers
    }

    private func filteredModels(for provider: ProviderCatalogEntry) -> [ProviderCatalogModel] {
        guard isSearching else {
            return provider.models
        }

        return provider.models.filter { model in
            provider.providerName.localizedCaseInsensitiveContains(trimmedQuery)
                || model.displayName.localizedCaseInsensitiveContains(trimmedQuery)
        }
    }

    private func toggleProvider(_ provider: ProviderCatalogEntry) {
        if collapsedProviderIDs.contains(provider.providerId.rawValue) {
            collapsedProviderIDs.remove(provider.providerId.rawValue)
        } else {
            collapsedProviderIDs.insert(provider.providerId.rawValue)
        }
    }

    private struct ModelRow: View {
        @Environment(\.theme) private var theme: Theme

        let displayName: String
        let isSelected: Bool
        let isEnabled: Bool
        let onSelect: () -> Void

        var body: some View {
            Button(action: onSelect) {
                HStack {
                    Text(displayName)
                        .foregroundStyle(theme.labelColor)
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark")
                            .foregroundStyle(theme.accentBlue)
                    }
                }
            }
            .disabled(!isEnabled)
            .opacity(isEnabled ? 1 : 0.4)
        }
    }
}

private extension ProviderId {
    var supportsNativeConnection: Bool {
        switch self {
        case .claudeCode, .openaiCodex:
            true
        case .unknown:
            false
        }
    }
}
