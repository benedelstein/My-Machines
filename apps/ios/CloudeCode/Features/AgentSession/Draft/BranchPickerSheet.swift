import CoreAPI
import SwiftUI

struct BranchPickerSheet: View {
    @Environment(\.style) var style: Style
    @Environment(\.dismiss) private var dismiss: DismissAction
    @Environment(\.theme) private var theme: Theme

    let draft: NewSessionDraft
    let selectedRepo: NewSessionDraft.SelectedRepo
    @State private var query: String = ""
    @State private var branches: [Branch] = []
    @State private var isLoading: Bool = true
    @State private var errorMessage: String?

    init(draft: NewSessionDraft, selectedRepo: NewSessionDraft.SelectedRepo) {
        self.draft = draft
        self.selectedRepo = selectedRepo

        let cachedBranches = draft.cachedBranches(repoId: selectedRepo.id)
        _branches = State(initialValue: cachedBranches ?? [])
        _isLoading = State(initialValue: cachedBranches == nil)
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    defaultBranchRow
                    loadingRows
                        .transition(style.fadeTransition)
                } else {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(theme.secondaryLabelColor)
                            .listRowBackground(Color.clear)
                    }

                    // The default branch is pinned to the top: it renders
                    // immediately (no layout shift once branches load) and
                    // it is usually the branch the user wants to pick.
                    if showsDefaultBranch {
                        defaultBranchRow
                    }

                    if !showsDefaultBranch && filteredBranchNames.isEmpty {
                        EmptyStateView(
                            title: "No branches found",
                            subtitle: "Try a different search."
                        ) {
                            Image(systemName: "arrow.triangle.branch")
                        }
                        .listRowBackground(Color.clear)
                        .transition(style.fadeTransition)
                    }

                    ForEach(filteredBranchNames, id: \.self) { branchName in
                        BranchRow(
                            name: branchName,
                            isSelected: branchName == draft.selectedBranch
                        ) {
                            draft.selectBranch(branchName)
                            dismiss()
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            // Explicit animation on the search text: transitions alone
            // stopped animating on iOS 26.
            .animation(style.fadeAnimation, value: query)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle("Select Base Branch")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .automatic)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .task {
                guard isLoading else {
                    return
                }
                await loadBranches()
            }
        }
    }

    private var loadingRows: some View {
        ForEach(0 ..< 5, id: \.self) { _ in
            BranchRow(
                name: "feature/branch-name",
                isSelected: false,
                isEnabled: false
            ) {}
            .redacted(reason: .placeholder)
        }
    }

    private var defaultBranchRow: some View {
        BranchRow(
            name: selectedRepo.defaultBranch,
            isSelected: selectedRepo.defaultBranch == draft.selectedBranch,
            showsDefaultBadge: true
        ) {
            draft.selectBranch(selectedRepo.defaultBranch)
            dismiss()
        }
    }

    private var nonDefaultBranchNames: [String] {
        branches.compactMap { branch in
            branch.name == selectedRepo.defaultBranch ? nil : branch.name
        }
    }

    private var filteredBranchNames: [String] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            return nonDefaultBranchNames
        }

        return nonDefaultBranchNames.filter {
            $0.localizedCaseInsensitiveContains(trimmedQuery)
        }
    }

    private var showsDefaultBranch: Bool {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedQuery.isEmpty
            || selectedRepo.defaultBranch.localizedCaseInsensitiveContains(trimmedQuery)
    }

    private func loadBranches() async {
        do {
            branches = try await draft.branches(repoId: selectedRepo.id)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private struct BranchRow: View {
        @Environment(\.theme) private var theme: Theme

        let name: String
        let isSelected: Bool
        let isEnabled: Bool
        let showsDefaultBadge: Bool
        let onSelect: () -> Void

        init(
            name: String,
            isSelected: Bool,
            isEnabled: Bool = true,
            showsDefaultBadge: Bool = false,
            onSelect: @escaping () -> Void
        ) {
            self.name = name
            self.isSelected = isSelected
            self.isEnabled = isEnabled
            self.showsDefaultBadge = showsDefaultBadge
            self.onSelect = onSelect
        }

        var body: some View {
            Button(action: onSelect) {
                HStack {
                    Text(name)
                        .foregroundStyle(theme.labelColor)
                    if showsDefaultBadge {
                        defaultBadge
                    }
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark")
                            .foregroundStyle(theme.accentBlue)
                    }
                }
            }
            .disabled(!isEnabled)
        }

        private var defaultBadge: some View {
            Text("default")
                .styledFont(.caption)
                .foregroundStyle(theme.secondaryLabelColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().foregroundStyle(theme.tertiaryBackgroundColor))
        }
    }
}
