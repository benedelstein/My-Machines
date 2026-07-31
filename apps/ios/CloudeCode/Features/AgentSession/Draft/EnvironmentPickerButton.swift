import Domain
import SwiftUI

/// Chip and navigation sheet for selecting, creating, or editing a repository environment.
struct EnvironmentPickerButton: View {
    let draft: NewSessionDraft
    @State private var isPickerPresented: Bool = false

    /// True until environments have been served from cache or network.
    private var isLoading: Bool {
        draft.environments == nil
    }

    var body: some View {
        Button {
            isPickerPresented = true
            // Opening is the explicit refresh boundary. Cached memory remains
            // visible while the canonical list refreshes in the background.
            Task { await draft.loadEnvironments(forceRefresh: true) }
        } label: {
            PickerChipLabel(
                icon: .monitorCog,
                title: draft.selectedEnvironment?.name ?? "No environment",
                maxTitleWidth: 132
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .redacted(reason: isLoading ? .placeholder : [])
        .accessibilityLabel("Select environment")
        .sheet(isPresented: $isPickerPresented) {
            PickerSheet(draft: draft)
        }
        .task(id: draft.selectedRepo?.id) {
            // Repo switches use memory when available; they do not force a refresh.
            await draft.loadEnvironments()
        }
    }
}

extension EnvironmentPickerButton {
    private enum Route: Hashable {
        case new
        case edit(String)
    }

    private struct PickerSheet: View {
        @Environment(\.dismiss) private var dismiss: DismissAction
        @Environment(\.theme) private var theme: Theme
        @Environment(\.environmentEditorBuilder) private var editorBuilder: EnvironmentEditorBuilder?

        let draft: NewSessionDraft
        @State private var path: [Route] = []
        @State private var detent: PresentationDetent = .medium

        var body: some View {
            NavigationStack(path: $path) {
                List {
                    ForEach(draft.environments ?? []) { environment in
                        EnvironmentRow(
                            environment: environment,
                            isSelected: environment.id == draft.selectedEnvironmentId,
                            onSelect: {
                                draft.selectEnvironment(environment.id)
                                dismiss()
                            },
                            onEdit: {
                                detent = .large
                                path.append(.edit(environment.id))
                            }
                        )
                    }
                    if let environments = draft.environments, environments.isEmpty {
                        EmptyStateView(
                            title: "No Environments",
                            subtitle: LocalizedStringResource(
                                stringLiteral: "Create a new environment to " +
                                "configure network access, env variables, " +
                                "and startup scripts for sessions in this repo."
                            )
                        ) {
                            Image(.monitorCog)
                        }
                        .listRowBackground(Color.clear)
                    }
                }
                .scrollContentBackground(.hidden)
                .contentMargins(.top, 0, for: .scrollContent)
                .navigationTitle("Select Environment")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }

                    ToolbarItem(placement: .topBarTrailing) {
                        Button("New") {
                            detent = .large
                            path.append(.new)
                        }
                        .glassButtonStyle(.glassProminent, tint: theme.accentBlue)
                        .disabled(draft.selectedRepo == nil || editorBuilder == nil)
                    }
                }
                .navigationDestination(for: Route.self, destination: destination)
            }
            .presentationDetents([.medium, .large], selection: $detent)
        }

        @ViewBuilder
        private func destination(for route: Route) -> some View {
            if let editorBuilder, let repo = draft.selectedRepo {
                switch route {
                case .new:
                    editorBuilder.build(
                        mode: .new(repoId: repo.id, repoFullName: repo.fullName),
                        onSaved: environmentCreated
                    )

                case let .edit(environmentId):
                    if let environment = draft.environments?.first(where: { $0.id == environmentId }) {
                        editorBuilder.build(
                            mode: .existing(environment: environment, repoFullName: repo.fullName),
                            onSaved: environmentEdited
                        )
                    } else {
                        Text("Environment is no longer available.")
                    }
                }
            } else {
                Text("Environment editor is unavailable.")
            }
        }

        private func environmentCreated(_ environment: Domain.RepoEnvironment) {
            draft.selectEnvironment(environment.id)
            dismiss()
        }

        private func environmentEdited(_: Domain.RepoEnvironment) {
            if !path.isEmpty {
                path.removeLast()
            }
        }
    }

    private struct EnvironmentRow: View {
        @Environment(\.theme) private var theme: Theme

        let environment: Domain.RepoEnvironment
        let isSelected: Bool
        let onSelect: () -> Void
        let onEdit: () -> Void

        var body: some View {
            HStack(spacing: 12) {
                Button(action: onSelect) {
                    HStack {
                        Text(environment.name)
                            .foregroundStyle(theme.labelColor)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if isSelected {
                            Image(systemName: "checkmark")
                                .foregroundStyle(theme.accentBlue)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Button(action: onEdit) {
                    Image(systemName: "pencil")
                        .foregroundStyle(theme.secondaryLabelColor)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(theme.tertiaryBackgroundColor))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit \(environment.name)")
            }
        }
    }
}
