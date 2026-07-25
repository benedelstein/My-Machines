import Domain
import SwiftUI
import UIKit

extension AgentSessionView {
    struct BranchBar: View {
        @Environment(\.hapticFeedbackPlayer) private var haptics
        @Environment(\.openURL) private var openURL
        @Environment(\.showToast) private var showToast
        @Environment(\.style) private var style
        @Environment(\.theme) private var theme

        let vm: AgentSessionViewModel

        var body: some View {
            if let branchName = vm.pushedBranchForDisplay {
                VStack(alignment: .leading, spacing: style.gridSize / 2) {
                    HStack(spacing: style.gridSize) {
                        statusIcon

                        copyButton(branchName: branchName)

                        Spacer(minLength: 0)

                        pullRequestAction
                    }

                    if let errorMessage = vm.pullRequestErrorMessage {
                        Text(verbatim: errorMessage)
                            .styledFont(.caption2)
                            .foregroundStyle(theme.errorRed)
                            .lineLimit(2)
                    }
                }
                .padding(.horizontal, style.spacing)
                .padding(.vertical, style.gridSize)
                .glassBackground(in: containerShape, interactive: false)
            }
        }

        private var containerShape: some Shape {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
        }

        @ViewBuilder
        private var statusIcon: some View {
            if vm.isPullRequestCreationInProgress {
                ProgressView()
                    .controlSize(.small)
                    .tint(theme.tertiaryLabelColor)
                    .frame(width: 24, height: 24)
                    .accessibilityLabel("Creating pull request")
            } else {
                let presentation = statusIconPresentation
                Image(presentation.image)
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .foregroundStyle(presentation.color)
                    .frame(width: 14, height: 14)
                    .frame(width: 24, height: 24)
                    .background(
                        presentation.color.opacity(0.15),
                        in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                    )
                    .accessibilityLabel(presentation.accessibilityLabel)
            }
        }

        private var statusIconPresentation: StatusIconPresentation {
            guard case .created(_, _, let state) = vm.pullRequestForDisplay else {
                return StatusIconPresentation(
                    image: .gitBranch,
                    color: theme.tertiaryLabelColor,
                    accessibilityLabel: "Pushed branch"
                )
            }

            switch state {
            case "merged":
                return StatusIconPresentation(
                    image: .gitMerge,
                    color: .purple,
                    accessibilityLabel: "Merged pull request"
                )
            case "closed":
                return StatusIconPresentation(
                    image: .gitPullRequestClosed,
                    color: theme.errorRed,
                    accessibilityLabel: "Closed pull request"
                )
            default:
                return StatusIconPresentation(
                    image: .gitPullRequest,
                    color: theme.green,
                    accessibilityLabel: "Open pull request"
                )
            }
        }

        private func copyButton(branchName: String) -> some View {
            Button {
                copyBranchName(branchName)
            } label: {
                HStack(spacing: style.gridSize / 2) {
                    Text(branchName)
                        .styledFont(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(theme.labelColor)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Image(systemName: "square.on.square")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.secondaryLabelColor)
                }
                .padding(.horizontal, style.gridSize / 2)
                .padding(.vertical, style.gridSize / 2)
                .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            }
            .buttonStyle(.highlight)
            .accessibilityLabel("Copy branch name")
            .accessibilityValue(branchName)
        }

        @ViewBuilder
        private var pullRequestAction: some View {
            if let pullRequestURL = vm.createdPullRequestURL {
                Link(destination: pullRequestURL) {
                    actionLabel(title: "View PR", systemImage: "arrow.up.right")
                }
            } else {
                Button {
                    Task {
                        if let pullRequestURL = await vm.createPullRequest() {
                            openURL(pullRequestURL)
                        }
                    }
                } label: {
                    if vm.isPullRequestCreationInProgress {
                        HStack(spacing: style.gridSize / 2) {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(theme.accentBlue)
                            Text("Creating...")
                        }
                        .actionLabelStyle(theme: theme, style: style)
                    } else {
                        actionLabel(title: showsRetryAction ? "Retry PR" : "Create PR")
                    }
                }
                .buttonStyle(.plain)
                .disabled(vm.isPullRequestCreationInProgress)
            }
        }

        private var showsRetryAction: Bool {
            if case .failed = vm.pullRequestForDisplay {
                return true
            }
            return vm.pullRequestOperationErrorMessage != nil
        }

        private func actionLabel(title: String, systemImage: String? = nil) -> some View {
            HStack(spacing: style.gridSize / 2) {
                Text(title)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 10, weight: .bold))
                }
            }
            .actionLabelStyle(theme: theme, style: style)
        }

        private func copyBranchName(_ branchName: String) {
            UIPasteboard.general.string = branchName
            haptics.play(.light)
            showToast?(title: "Copied", icon: Image(systemName: "square.on.square"))
        }
    }
}

private struct StatusIconPresentation {
    let image: ImageResource
    let color: Color
    let accessibilityLabel: LocalizedStringKey
}

private extension View {
    func actionLabelStyle(theme: Theme, style: Style) -> some View {
        styledFont(.caption)
            .fontWeight(.bold)
            .foregroundStyle(theme.accentBlue)
            .padding(.horizontal, style.gridSize + style.gridSize / 2)
            .padding(.vertical, style.gridSize / 2)
            .background(
                theme.accentBlue.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
    }
}
