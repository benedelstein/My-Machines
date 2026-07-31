import AuthenticationServices
import CoreAPI
import SwiftUI

struct RepoPickerSheet: View {
    @Environment(\.style) var style: Style
    @Environment(\.dismiss) private var dismiss: DismissAction
    @Environment(\.theme) private var theme: Theme
    @Environment(\.webAuthenticationSession)
    private var webAuthenticationSession: WebAuthenticationSession

    let draft: NewSessionDraft
    @State private var query: String = ""
    @State private var visibleRepos: [Repo] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var isSearching: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if isInitialLoading {
                    loadingRows(count: 6)
                        .transition(style.fadeTransition)
                } else {
                    content
                        .transition(style.fadeTransition)

                    if isSearching {
                        loadingRows(count: 1)
                            .transition(style.fadeTransition)
                    }
                }

                if showsEmptyContent {
                    Section {
                        manageRepositoriesRow
                    }
                } else {
                    manageRepositoriesRow
                }
            }
            .animation(style.fadeAnimation, value: isSearching)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle("Select Repository")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .automatic)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .onAppear {
                visibleRepos = draft.repos
            }
            .onChange(of: query) { _, newValue in
                scheduleSearch(newValue)
            }
            .onChange(of: draft.repos) { _, repos in
                guard query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return
                }
                visibleRepos = repos
            }
            .onDisappear {
                searchTask?.cancel()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let errorMessage, visibleRepos.isEmpty {
            ErrorStateView(
                title: "Repository unavailable",
                verbatimSubtitle: errorMessage
            ) {
                Image(systemName: "exclamationmark.triangle")
            }
            .listRowBackground(Color.clear)
        } else if visibleRepos.isEmpty {
            EmptyStateView(
                title: "No repositories found",
                subtitle: query.isEmpty
                    ? "Manage which repositories the app can access on GitHub."
                    : "Try a different search."
            ) {
                Image(systemName: "folder")
            }
            .listRowBackground(Color.clear)
        } else if showsRecents {
            Section("Recents") {
                ForEach(draft.recentRepos, id: \.id) { recent in
                    RepoRow(
                        fullName: recent.fullName,
                        isSelected: recent.id == draft.selectedRepo?.id
                    ) {
                        draft.selectRepo(recent)
                        dismiss()
                    }
                    .transition(style.fadeTransition)
                }
            }

            Section("All") {
                repoRows
            }
        } else {
            repoRows
        }
    }

    private var repoRows: some View {
        ForEach(visibleRepos, id: \.id) { repo in
            RepoRow(
                fullName: repo.fullName,
                isSelected: repo.id == draft.selectedRepo?.id
            ) {
                draft.selectRepo(repo)
                dismiss()
            }
            .transition(style.fadeTransition)
        }
    }

    /// Recents only make sense against the full listing; hide them while a
    /// search query filters the results.
    private var showsRecents: Bool {
        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !draft.recentRepos.isEmpty
    }

    private var manageRepositoriesRow: some View {
        Button {
            Task {
                await draft.manageGitHubRepositories(using: webAuthenticationSession)
                scheduleSearch(query)
            }
        } label: {
            HStack(spacing: style.gridSize) {
                VStack(alignment: .leading, spacing: style.gridSize / 2) {
                    Text("Don't see your repository?")
                        .styledFont(.caption)
                        .foregroundStyle(theme.secondaryLabelColor)

                    Text("Manage repositories on GitHub")
                        .styledFont(.subheadline)
                        .foregroundStyle(theme.labelColor)

                    if let error = draft.githubRepositoryManagementError {
                        Text(verbatim: error)
                            .styledFont(.caption)
                            .foregroundStyle(theme.errorRed)
                    }
                }

                Spacer()

                if draft.isManagingGitHubRepositories {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.up.right")
                        .foregroundStyle(theme.secondaryLabelColor)
                }
            }
        }
        .disabled(draft.isManagingGitHubRepositories)
    }

    private func loadingRows(count: Int) -> some View {
        ForEach(0 ..< count, id: \.self) { _ in
            RepoRow(
                fullName: "owner/repository-name",
                isSelected: false,
                isEnabled: false
            ) {}
            .redacted(reason: .placeholder)
        }
    }

    private var isInitialLoading: Bool {
        visibleRepos.isEmpty && (isSearching || draft.isLoadingRepos)
    }

    private var showsEmptyContent: Bool {
        visibleRepos.isEmpty && !isInitialLoading
    }

    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()

        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            isSearching = false
            errorMessage = nil
            visibleRepos = draft.repos
            return
        }

        isSearching = true
        errorMessage = nil
        searchTask = Task {
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else {
                    return
                }

                let repos = try await draft.searchRepos(query: trimmedQuery)
                guard !Task.isCancelled, query == self.query else {
                    return
                }

                visibleRepos = repos
                isSearching = false
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, query == self.query else {
                    return
                }

                errorMessage = error.localizedDescription
                isSearching = false
            }
        }
    }

    private struct RepoRow: View {
        @Environment(\.theme) private var theme: Theme

        let fullName: String
        let isSelected: Bool
        let isEnabled: Bool
        let onSelect: () -> Void

        init(
            fullName: String,
            isSelected: Bool,
            isEnabled: Bool = true,
            onSelect: @escaping () -> Void
        ) {
            self.fullName = fullName
            self.isSelected = isSelected
            self.isEnabled = isEnabled
            self.onSelect = onSelect
        }

        var body: some View {
            Button(action: onSelect) {
                HStack {
                    Text(fullName)
                        .styledFont(.body)
                        .foregroundStyle(theme.labelColor)
                        .lineLimit(1)

                    Spacer()

                    if isSelected {
                        Image(systemName: "checkmark")
                            .foregroundStyle(theme.accentBlue)
                    }
                }
            }
            .disabled(!isEnabled)
        }
    }
}
