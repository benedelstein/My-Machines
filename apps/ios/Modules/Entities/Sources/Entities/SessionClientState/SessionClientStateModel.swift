import Domain
import Observation

/// Observable model for one cached session client-state snapshot.
@MainActor
@Observable
public final class SessionClientStateModel: EntityModel {
    public typealias EntityType = SessionClientStateEntity

    public let id: String
    public var repoFullName: String?
    public var status: SessionClientState.Status
    public var sessionSetupRun: SessionClientState.SessionSetupRun?
    public var agentSettings: SessionClientState.AgentSettings
    public var pullRequest: SessionClientState.PullRequest?
    public var pushedBranch: String?
    public var baseBranch: String?
    public var agentMode: SessionClientState.AgentMode
    public var isResponding: Bool

    /// Creates a model from a curated client-state snapshot.
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

    /// Merges a curated client-state snapshot into this model.
    public func update(from snapshot: Domain.SessionClientStateSnapshot) {
        updateIfChanged(\.repoFullName, to: snapshot.repoFullName)
        updateIfChanged(\.status, to: snapshot.status)
        updateIfChanged(\.sessionSetupRun, to: snapshot.sessionSetupRun)
        updateIfChanged(\.agentSettings, to: snapshot.agentSettings)
        updateIfChanged(\.pullRequest, to: snapshot.pullRequest)
        updateIfChanged(\.pushedBranch, to: snapshot.pushedBranch)
        updateIfChanged(\.baseBranch, to: snapshot.baseBranch)
        updateIfChanged(\.agentMode, to: snapshot.agentMode)
        updateIfChanged(\.isResponding, to: snapshot.isResponding)
    }

    public var snapshot: Domain.SessionClientStateSnapshot {
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
}

/// Identity-mapped cache store for curated session client state.
public typealias SessionClientStateStore = EntityStore<SessionClientStateModel>
