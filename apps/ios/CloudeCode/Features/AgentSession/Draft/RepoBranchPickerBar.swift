import SwiftUI

struct RepoBranchPickerBar: View {
    @Environment(\.style) private var style: Style

    let draft: NewSessionDraft
    @State private var isRepositorySheetPresented: Bool = false
    @State private var isBranchSheetPresented: Bool = false

    var body: some View {
        HStack(spacing: style.gridSize) {
            repositoryButton

            if let selectedRepo = draft.selectedRepo {
                branchButton(for: selectedRepo)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .sheet(isPresented: $isRepositorySheetPresented) {
            RepoPickerSheet(draft: draft)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $isBranchSheetPresented) {
            if let selectedRepo = draft.selectedRepo {
                BranchPickerSheet(draft: draft, selectedRepo: selectedRepo)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    private var repositoryButton: some View {
        Button {
            isRepositorySheetPresented = true
        } label: {
            PickerChipLabel(
                icon: .folderGit2,
                title: draft.selectedRepo?.fullName ?? "Repository",
                maxTitleWidth: 132
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Select repository")
    }

    private func branchButton(for selectedRepo: NewSessionDraft.SelectedRepo) -> some View {
        Button {
            isBranchSheetPresented = true
        } label: {
            PickerChipLabel(
                icon: .gitBranch,
                title: draft.selectedBranch ?? selectedRepo.defaultBranch,
                maxTitleWidth: 100
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Select base branch")
    }
}
