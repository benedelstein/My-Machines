import Domain
import Foundation
import SwiftUI

/// Native form for creating or editing a repository environment.
struct EnvironmentEditorView: View {
    private static let defaultAllowlistSheetURL: URL? = URL(
        string: "\(Constants.deepLinkScheme)://default-allowlist"
    )

    @Environment(\.theme) private var theme: Theme
    @State private var viewModel: EnvironmentEditorViewModel
    let onSaved: (Domain.RepoEnvironment) -> Void
    @FocusState private var isNameFocused: Bool
    @State private var didFinishEditingName: Bool = false
    @State private var isDefaultAllowlistPresented: Bool = false

    init(
        viewModel: EnvironmentEditorViewModel,
        onSaved: @escaping (Domain.RepoEnvironment) -> Void
    ) {
        _viewModel = State(initialValue: viewModel)
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            repositorySection
            networkSection
            if viewModel.networkMode == .custom {
                customNetworkSection
            }
            runtimeSection
        }
        .navigationTitle(viewModel.navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(viewModel.isSaving)
        .interactiveDismissDisabled(viewModel.isSaving)
        .onOpenURL { url in
            guard url == Self.defaultAllowlistSheetURL else { return }
            isDefaultAllowlistPresented = true
        }
        .toolbar {
            if case let .existing(environment, _) = viewModel.mode,
               let webURL = URL(
                   string: "\(Constants.webBaseURL)/settings/environments/\(environment.id)"
               ) {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Link(destination: webURL) {
                        Image(systemName: "globe")
                    }
                    .accessibilityLabel("View on web")
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        if let environment = await viewModel.submit() {
                            onSaved(environment)
                        }
                    }
                } label: {
                    Group {
                        if viewModel.isSaving {
                            ProgressView()
                        } else {
                            Image(systemName: "checkmark")
                        }
                    }
                    .foregroundStyle(theme.labelColor)
                }
                .glassButtonStyle(.glassProminent, tint: theme.accentBlue)
                .disabled(!viewModel.canSubmit)
                .accessibilityLabel(viewModel.mode.isNew ? "Create environment" : "Save environment")
            }
        }
        .alert(
            "Couldn’t save environment",
            isPresented: Binding(
                get: { viewModel.errorMessage != nil },
                set: { if !$0 { viewModel.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "Unknown error")
        }
        .sheet(isPresented: $isDefaultAllowlistPresented) {
            DefaultAllowlistSheet(viewModel: viewModel)
                .presentationDragIndicator(.visible)
        }
    }

    private var repositorySection: some View {
        Section {
            LabeledContent("Repository", value: viewModel.repoFullName)
            TextField("Environment name", text: $viewModel.name)
                .focused($isNameFocused)
                .onChange(of: viewModel.name) { _, value in
                    if value.count > 80 {
                        viewModel.name = String(value.prefix(80))
                    }
                }
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text("Repository scope cannot be changed after creation.")
                if didFinishEditingName {
                    FieldError(message: viewModel.nameError)
                }
            }
        }
        .onChange(of: isNameFocused) { wasFocused, isFocused in
            if wasFocused, !isFocused {
                didFinishEditingName = true
            }
        }
    }

    private var networkSection: some View {
        Section {
            Picker("Network access", selection: $viewModel.networkMode) {
                ForEach(EnvironmentEditorViewModel.NetworkMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.menu)
        } header: {
            Text("Network")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text(networkDescription)

                if let unsupportedNetworkMode = viewModel.unsupportedNetworkMode {
                    FieldError(
                        message: "This environment uses unsupported network mode \(unsupportedNetworkMode)."
                    )
                }

                if viewModel.networkMode != .locked {
                    CalloutView(tint: theme.accentOrange, systemImage: "exclamationmark.triangle") {
                        Text("Internet access poses security risks. Limit access to known safe domains when possible.")
                    }
                }
            }
        }
    }

    private var networkDescription: AttributedString {
        var description = AttributedString(viewModel.networkMode.description)
        guard viewModel.networkMode == .default || viewModel.networkMode == .custom,
              let defaultAllowlistURL = Self.defaultAllowlistSheetURL,
              let linkRange = description.range(of: "default allowlist") else {
            return description
        }
        description[linkRange].link = defaultAllowlistURL
        description[linkRange].underlineStyle = Text.LineStyle(pattern: .solid)
        description[linkRange].foregroundColor = theme.secondaryLabelColor
        return description
    }

    private var customNetworkSection: some View {
        Section {
            Toggle("Include default allowlist", isOn: $viewModel.includeDefaultAllowlist)
            PlaceholderTextEditor(
                text: $viewModel.allowedDomainsText,
                placeholder: "api.example.com\n*.example.com",
                minHeight: 96,
                accessibilityLabel: "Allowed domains"
            )
        } header: {
            Text("Allowed domains")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text("Enter one hostname per line, such as api.example.com or *.example.com.")
                FieldError(message: viewModel.allowedDomainsError)
            }
        }
    }

    private var runtimeSection: some View {
        Group {
            Section {
                PlaceholderTextEditor(
                    text: $viewModel.plainEnvVarsText,
                    placeholder: "NEXT_PUBLIC_API_URL=https://example.com",
                    minHeight: 112,
                    accessibilityLabel: "Environment variables"
                )
            } header: {
                Text("Environment variables")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Use KEY=value, one per line. Values are stored in plaintext; do not store secrets here.")
                    FieldError(message: viewModel.plainEnvVarsError)
                }
            }

            Section {
                Text("Coming soon")
                    .foregroundStyle(theme.secondaryLabelColor)
            } header: {
                Text("Secrets")
            }

            Section {
                PlaceholderTextEditor(
                    text: $viewModel.startupScript,
                    placeholder: "pnpm install",
                    minHeight: 176,
                    accessibilityLabel: "Startup script"
                )
            } header: {
                Text("Startup script")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(
                        "Runs from the workspace root after clone and before the first agent turn. "
                            + "Network access is enabled while it runs."
                    )
                    FieldError(message: viewModel.startupScriptError)
                }
            }
        }
    }
}

extension EnvironmentEditorView {
    struct DefaultAllowlistSheet: View {
        @Environment(\.dismiss) private var dismiss: DismissAction
        let viewModel: EnvironmentEditorViewModel

        var body: some View {
            NavigationStack {
                content
                    .navigationTitle("Default Allowlist")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .task {
                await viewModel.loadDefaultAllowlist()
            }
        }

        @ViewBuilder
        private var content: some View {
            if let domains = viewModel.defaultAllowlistDomains {
                List(domains, id: \.self) { domain in
                    Text(verbatim: domain)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            } else if let error = viewModel.defaultAllowlistError {
                ErrorStateView(
                    title: "Couldn’t Load Allowlist",
                    verbatimSubtitle: error
                ) {
                    Image(systemName: "exclamationmark.triangle")
                } action: {
                    StatePillButton(title: "Try Again") {
                        Task {
                            await viewModel.loadDefaultAllowlist()
                        }
                    }
                }
            } else {
                ProgressView("Loading allowlist…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    struct PlaceholderTextEditor: View {
        @Environment(\.theme) private var theme: Theme
        @Binding var text: String
        let placeholder: String
        let minHeight: CGFloat
        let accessibilityLabel: String

        var body: some View {
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: minHeight)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(verbatim: placeholder)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(theme.tertiaryLabelColor)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityLabel(accessibilityLabel)
        }
    }

    struct FieldError: View {
        let message: String?

        var body: some View {
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }
}

private extension EnvironmentEditorViewModel.Mode {
    var isNew: Bool {
        if case .new = self { return true }
        return false
    }
}
