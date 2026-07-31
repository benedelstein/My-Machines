import SwiftUI

extension HomeView {
    struct PaginationButton: View {
        @Environment(\.theme) private var theme
        @Environment(\.style) private var style

        let title: String
        let isLoading: Bool
        let action: () async -> Void

        var body: some View {
            Button {
                Task {
                    await action()
                }
            } label: {
                Group {
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(theme.secondaryLabelColor)
                    } else {
                        Text(title)
                            .styledFont(.subheadline)
                            .foregroundStyle(theme.secondaryLabelColor)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isLoading)
            .listRowInsets(
                EdgeInsets(
                    top: 0,
                    leading: style.horizontalPadding,
                    bottom: 0,
                    trailing: style.horizontalPadding
                )
            )
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .accessibilityLabel(title)
        }
    }

    struct RepositoryPaginationTrigger: View {
        @Environment(\.theme) private var theme

        let isLoading: Bool
        let action: () async -> Void

        var body: some View {
            Group {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(theme.secondaryLabelColor)
                        .accessibilityLabel("Loading more repositories")
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .onAppear {
                Task {
                    await action()
                }
            }
        }
    }

    struct RepoSectionHeader: View {
        @Environment(\.theme) private var theme
        @Environment(\.style) private var style

        let group: HomeSessionGroup
        @Binding var isExpanded: Bool

        var body: some View {
            Button {
                withAnimation(style.springAnimation) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: style.gridSize) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 16, height: 16)

                    Image(.folderGit2)
                        .resizable()
                        .renderingMode(.template)
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 16, height: 16)

                    Text(group.repoFullName)
                        .styledFont(.subheadline)
                        .lineLimit(1)

                    Spacer()

                    Text(group.sessions.count.formatted())
                        .styledFont(.caption)
                        .foregroundStyle(theme.tertiaryLabelColor)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.secondaryLabelColor)
            .textCase(nil)
            .accessibilityLabel(group.repoFullName)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Toggles repository sessions")
        }
    }
}
