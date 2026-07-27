import CoreAPI
import Domain
import Foundation

/// A repository and its cursor-paginated session summaries.
public struct SessionRepoPage: Sendable, Equatable, Identifiable {
    public let repoId: Int
    public let repoFullName: String
    public let sessions: CursorPage<Domain.SessionSummary>

    public var id: Int {
        repoId
    }

    /// Creates a repository page.
    public init(
        repoId: Int,
        repoFullName: String,
        sessions: CursorPage<Domain.SessionSummary>
    ) {
        self.repoId = repoId
        self.repoFullName = repoFullName
        self.sessions = sessions
    }
}

/// A cursor-paginated page of repository session pages.
public typealias SessionSummaryPage = CursorPage<SessionRepoPage>

extension CoreAPI.SessionSummary {
    var domainSummary: Domain.SessionSummary {
        Domain.SessionSummary(
            id: id,
            repoId: repoId,
            repoFullName: repoFullName,
            provider: provider?.domainProviderID,
            title: title,
            archived: archived,
            status: status?.domainSummaryStatus,
            workingState: workingState.rawValue,
            pushedBranch: pushedBranch,
            pullRequest: pullRequest.map {
                Domain.SessionSummary.PullRequest(
                    url: $0.url,
                    number: $0.number,
                    state: $0.state.rawValue
                )
            },
            createdAt: createdAt,
            updatedAt: updatedAt,
            lastMessageAt: lastMessageAt,
            lastAssistantMessageId: lastAssistantMessageId,
            hasUnread: hasUnread
        )
    }
}

private extension CoreAPI.ProviderId {
    var domainProviderID: AgentProviderID {
        switch self {
        case .claudeCode:
            .claudeCode
        case .openaiCodex:
            .openaiCodex
        case .unknown(let value):
            .unknown(value)
        }
    }
}

private extension CoreAPI.SessionStatus {
    var domainSummaryStatus: Domain.SessionStatus {
        switch self {
        case .preparing:
            .preparing
        case .setupFailed:
            .setupFailed
        case .ready:
            .ready
        case .unknown(let value):
            .unknown(value)
        }
    }
}

extension ListSessionsResponse {
    var summaryPage: SessionSummaryPage {
        CursorPage(
            values: groups.map { group in
                SessionRepoPage(
                    repoId: group.repoId,
                    repoFullName: group.repoFullName,
                    sessions: CursorPage(
                        values: group.sessions.map(\.domainSummary),
                        nextCursor: group.nextSessionCursor
                    )
                )
            },
            nextCursor: nextRepoCursor
        )
    }
}
