import Domain
import Entities
import Foundation
import SwiftUI

struct HomeView: View {
    @Environment(\.theme) var theme: Theme
    @Environment(\.style) private var style
    @Environment(\.openSettings) private var openSettings
    @Environment(\.showToast) private var showToast
    @Environment(\.notificationRegistrationService)
    private var notificationRegistrationService: NotificationRegistrationService?

    @State private var viewModel: HomeViewModel
    @State private var router: HomeRouter
    @State private var collapsedRepoIDs = Set<Int>()
    @State private var sessionPendingDelete: SessionSummaryModel?
    let sessionBuilder: AgentSessionBuilder

    init(
        viewModel: HomeViewModel,
        router: HomeRouter,
        sessionBuilder: AgentSessionBuilder
    ) {
        _viewModel = State(initialValue: viewModel)
        _router = State(initialValue: router)
        self.sessionBuilder = sessionBuilder
    }

    var body: some View {
        NavigationStack(path: $router.path) {
            contentWithFAB
                .background(theme.backgroundColor)
                .ignoresSafeArea(.keyboard)
                // .navigationTitle("Sessions")
                .toolbar { settingsToolbar }
                .navigationDestination(for: HomeDestination.self) { destination in
                    switch destination {
                    case .session(let session):
                        sessionBuilder.build(session: session)
                    case .newSession:
                        sessionBuilder.buildNewSession()
                    }
                }
                .onChange(of: viewModel.errorMessage) { _, errorMessage in
                    guard let errorMessage else {
                        return
                    }
                    showToast?(
                        title: Text(verbatim: errorMessage),
                        icon: Image(systemName: "exclamationmark.circle.fill")
                    )
                }
                .alert(
                    "Delete session?",
                    isPresented: deleteConfirmationPresented,
                    presenting: sessionPendingDelete
                ) { session in
                    Button("Delete", role: .destructive) {
                        Task {
                            await viewModel.delete(session)
                        }
                    }
                    Button("Cancel", role: .cancel) {
                        sessionPendingDelete = nil
                    }
                } message: { session in
                    Text("This permanently deletes \(session.title ?? "this session").")
                }
        }
        .onChange(of: router.notificationTap) { _, _ in
            Task {
                await router.handlePendingNotificationTap()
            }
        }
        // Outside the NavigationStack: pushes/pops re-evaluate the stack's
        // content, and we only want to bind once per appearance of Home.
        .task {
            router.start()
            async let notifications: Void = prepareNotifications()
            await viewModel.start()
            await router.handlePendingNotificationTap()
            await notifications
        }
        .onDisappear {
            router.stop()
            viewModel.unload()
        }
    }

    private func prepareNotifications() async {
        guard let notificationRegistrationService else { return }
        await notificationRegistrationService.requestNotificationAuthorization()
    }

    @ViewBuilder
    private var contentWithFAB: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.secondaryBackgroundColor)
            .overlay(alignment: .bottomTrailing) {
                Button {
                    router.pushNewSession()
                } label: {
                    Image(systemName: "plus.message.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .glassButtonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .accessibilityLabel("New session")
                .padding(style.horizontalPadding)
            }
    }

    @ViewBuilder
    private var content: some View {
        sessionsList
    }

    private var sessionsList: some View {
        List {
            if viewModel.isLoading {
                // todo loading rows
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if viewModel.isEmpty && viewModel.hasLoaded {
                EmptyStateView(
                    title: "No sessions"
                ) {
                    Image(systemName: "message.fill")
                }
                .padding(.top, 24)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            ForEach(viewModel.groups) { group in
                Section(isExpanded: expandedBinding(for: group)) {
                    ForEach(group.sessions) { session in
                        sessionLink(for: session)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 16)
                            .background(
                                theme.backgroundColor,
                                in: RoundedRectangle(
                                    cornerRadius: 20,
                                    style: .continuous
                                )
                            )
                            .listRowInsets(
                                EdgeInsets(
                                    top: 8,
                                    leading: style.horizontalPadding,
                                    bottom: 0,
                                    trailing: style.horizontalPadding
                                )
                            )
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }

                    if group.hasNextPage {
                        PaginationButton(
                            title: "Load more sessions",
                            isLoading: viewModel.loadingSessionRepoIDs.contains(group.repoId)
                        ) {
                            await viewModel.loadMoreSessions(repoId: group.repoId)
                        }
                    }
                } header: {
                    RepoSectionHeader(
                        group: group,
                        isExpanded: expandedBinding(for: group)
                    )
                }
            }
            .listRowSpacing(style.gridSize) // idt this works

            if let cursor = viewModel.nextRepositoryCursor {
                RepositoryPaginationTrigger(
                    isLoading: viewModel.isLoadingMoreRepositories
                ) {
                    await viewModel.loadMoreRepositories()
                }
                .id(cursor)
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.secondaryBackgroundColor)
        .animation(.default, value: viewModel.groups)
        .listStyle(.plain)
        .refreshable {
            await viewModel.refresh()
        }
    }

    private func sessionLink(for session: SessionSummaryModel) -> some View {
        NavigationLink(value: HomeDestination.session(session)) {
            SessionRow(session: session)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                sessionPendingDelete = session
            } label: {
                Label("", systemImage: "trash")
            }
            .tint(.red)
            .accessibilityLabel("Delete")

            Button {
                Task {
                    await viewModel.archive(session)
                }
            } label: {
                Label("", systemImage: "archivebox")
            }
            .tint(.gray)
            .accessibilityLabel("Archive")
        }
    }

    @ToolbarContentBuilder
    private var settingsToolbar: some ToolbarContent {
        if let openSettings {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    openSettings()
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Settings")
            }
        }
    }

    private func expandedBinding(for group: HomeSessionGroup) -> Binding<Bool> {
        Binding {
            !collapsedRepoIDs.contains(group.id)
        } set: { isExpanded in
            if isExpanded {
                collapsedRepoIDs.remove(group.id)
            } else {
                collapsedRepoIDs.insert(group.id)
            }
        }
    }

    private var deleteConfirmationPresented: Binding<Bool> {
        Binding {
            sessionPendingDelete != nil
        } set: { isPresented in
            if !isPresented {
                sessionPendingDelete = nil
            }
        }
    }
}

private struct SessionRow: View {
    @Environment(\.theme) private var theme
    @Environment(\.style) private var style

    let session: SessionSummaryModel

    var title: String {
        session.title ?? "Untitled session"
    }

    private var isPreparing: Bool {
        session.status == .preparing
    }

    var body: some View {
        HStack(alignment: .center, spacing: style.gridSize * 1.5) {
            SessionArtifactIcon(session: session, width: style.gridSize * 2)
                .frame(width: 28, height: 28)
                .background(
                    theme.tertiaryBackgroundColor.opacity(0.6),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )

            VStack(alignment: .leading) {
                Text(title)
                    .styledFont(.headline)
                    .foregroundStyle(theme.labelColor)
                    .id(title)
                    .transition(.blurReplace.animation(.easeIn))
                    .lineLimit(1)

                if isPreparing {
                    Text("Initializing session")
                        .styledFont(.caption)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .lineLimit(1)
                } else if session.status == .setupFailed {
                    Text("Setup failed")
                        .styledFont(.caption)
                        .foregroundStyle(theme.errorRed)
                        .lineLimit(1)
                } else if let pushedBranch = session.pushedBranch {
                    Text(pushedBranch)
                        .styledFont(.caption)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: style.gridSize)

            SessionAttentionSlot(session: session)
        }
        .animation(style.fadeAnimation, value: title)
        .animation(style.fadeAnimation, value: session.snapshot)
    }
}

private struct SessionArtifactIcon: View {
    @Environment(\.theme) private var theme
    @Environment(\.style) private var style

    let session: SessionSummaryModel
    var width: CGFloat

    var body: some View {
        Group {
            if let icon = artifactIcon {
                Image(icon.0)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(icon.1)
            } else {
                Color.clear
            }
        }
        .frame(width: width, height: width)
    }

    private var artifactIcon: (ImageResource, Color)? {
        if let pullRequest = session.pullRequest {
            return icon(for: pullRequest)
        }

        if session.pushedBranch != nil {
            return (.gitBranch, theme.secondaryLabelColor)
        }

        return nil
    }

    private func icon(for pullRequest: Domain.SessionSummary.PullRequest) -> (ImageResource, Color) {
        switch pullRequest.state {
        case "merged":
            return (.gitMerge, .purple)
        case "closed":
            return (.gitPullRequestClosed, theme.errorRed)
        default:
            return (.gitPullRequest, .green)
        }
    }
}

private struct ArtifactIcon {
    let systemName: String
    let color: Color
    let accessibilityLabel: String
}

private struct SessionAttentionSlot: View {
    @Environment(\.theme) private var theme
    @Environment(\.style) private var style

    let session: SessionSummaryModel

    var body: some View {
        Group {
            if session.status == .preparing {
                ProgressView()
                    .controlSize(.small)
                    .tint(theme.secondaryLabelColor)
                    .accessibilityLabel("Initializing session")
            } else if session.status == .setupFailed {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(theme.errorRed)
                    .accessibilityLabel("Setup failed")
            } else if session.workingState == "responding" {
                ProgressView()
                    .controlSize(.small)
                    .tint(theme.secondaryLabelColor)
                    .accessibilityLabel("Responding")
            } else if session.hasUnread {
                Circle()
                    .fill(theme.accentBlue)
                    .frame(width: style.gridSize, height: style.gridSize)
                    .accessibilityLabel("Unread message")
            } else {
                TimelineView(.everyMinute) { _ in
                    Text(SessionTimestampFormatter.relativeString(for: session.activityTimestamp))
                        .styledFont(.caption)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .lineLimit(1)
                }
            }
        }
        .transition(.blurReplace)
    }
}

private enum SessionTimestampFormatter {
    private static let fractionalISOFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoFormatter = ISO8601DateFormatter()

    static func relativeString(for timestamp: String, relativeTo now: Date = Date()) -> String {
        guard let date = fractionalISOFormatter.date(from: timestamp) ?? isoFormatter.date(from: timestamp) else {
            return ""
        }

        let second: TimeInterval = 1
        let minute = 60 * second
        let hour = 60 * minute
        let day = 24 * hour
        let week = 7 * day
        let month = 30 * day
        let elapsed = max(0, now.timeIntervalSince(date))

        if elapsed < minute {
            let seconds = Int(elapsed / second)
            return seconds == 0 ? "Now" : "\(seconds)s"
        }
        if elapsed < hour {
            return "\(Int(elapsed / minute))m"
        }
        if elapsed < day {
            return "\(Int(elapsed / hour))h"
        }
        if elapsed < week {
            return "\(Int(elapsed / day))d"
        }
        if elapsed < month {
            return "\(Int(elapsed / week))w"
        }
        return "\(Int(elapsed / month))mo"
    }
}

private extension SessionSummaryModel {
    var activityTimestamp: String {
        lastMessageAt ?? updatedAt
    }
}
