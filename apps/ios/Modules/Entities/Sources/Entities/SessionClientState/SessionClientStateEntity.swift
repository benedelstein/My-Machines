import Domain
import SwiftData

/// SwiftData persistence row for one curated session client-state snapshot.
@Model
public final class SessionClientStateEntity: Entity {
    @Attribute(.unique) public private(set) var id: String
    var repoFullName: String?
    var status: SessionClientState.Status
    var sessionSetupRun: SessionClientState.SessionSetupRun?
    var agentSettings: SessionClientState.AgentSettings
    var pullRequest: SessionClientState.PullRequest?
    var pushedBranch: String?
    var baseBranch: String?
    var agentMode: SessionClientState.AgentMode
    var isResponding: Bool

    /// Creates a persistence row from a curated client-state snapshot.
    public init(_ snapshot: Domain.SessionClientStateSnapshot) {
        id = snapshot.id
        repoFullName = snapshot.repoFullName
        status = snapshot.status
        sessionSetupRun = snapshot.sessionSetupRun
        agentSettings = snapshot.agentSettings
        pullRequest = snapshot.pullRequest
        pushedBranch = snapshot.pushedBranch
        baseBranch = snapshot.baseBranch
        agentMode = snapshot.agentMode
        isResponding = snapshot.isResponding
    }

    /// Replaces this row with a curated client-state snapshot.
    public func update(_ snapshot: Domain.SessionClientStateSnapshot) {
        repoFullName = snapshot.repoFullName
        status = snapshot.status
        sessionSetupRun = snapshot.sessionSetupRun
        agentSettings = snapshot.agentSettings
        pullRequest = snapshot.pullRequest
        pushedBranch = snapshot.pushedBranch
        baseBranch = snapshot.baseBranch
        agentMode = snapshot.agentMode
        isResponding = snapshot.isResponding
    }

    /// Builds a curated client-state snapshot from this persistence row.
    public func makeSnapshot() throws -> Domain.SessionClientStateSnapshot {
        Domain.SessionClientStateSnapshot(
            id: id,
            repoFullName: repoFullName,
            status: status,
            sessionSetupRun: sessionSetupRun,
            agentSettings: agentSettings,
            pullRequest: pullRequest,
            pushedBranch: pushedBranch,
            baseBranch: baseBranch,
            agentMode: agentMode,
            isResponding: isResponding
        )
    }

    /// Builds a predicate matching one session ID.
    public static func singleItemPredicate(_ id: String) -> Predicate<SessionClientStateEntity> {
        #Predicate { $0.id == id }
    }

    /// Builds a predicate matching a set of session IDs.
    public static func multiItemPredicate(_ ids: Set<String>) -> Predicate<SessionClientStateEntity> {
        #Predicate { ids.contains($0.id) }
    }
}
