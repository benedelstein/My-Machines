/// Curated session client state persisted for cache-first screen restoration.
public struct SessionClientStateSnapshot: Sendable, Equatable, Codable, Identifiable {
    public let id: String
    public let repoFullName: String?
    public let status: SessionClientState.Status
    public let sessionSetupRun: SessionClientState.SessionSetupRun?
    public let agentSettings: SessionClientState.AgentSettings
    public let pullRequest: SessionClientState.PullRequest?
    public let pushedBranch: String?
    public let baseBranch: String?
    public let agentMode: SessionClientState.AgentMode
    public let isResponding: Bool

    /// Creates a curated snapshot for one session.
    public init(
        id: String,
        repoFullName: String?,
        status: SessionClientState.Status,
        sessionSetupRun: SessionClientState.SessionSetupRun?,
        agentSettings: SessionClientState.AgentSettings,
        pullRequest: SessionClientState.PullRequest?,
        pushedBranch: String?,
        baseBranch: String?,
        agentMode: SessionClientState.AgentMode,
        isResponding: Bool
    ) {
        self.id = id
        self.repoFullName = repoFullName
        self.status = status
        self.sessionSetupRun = sessionSetupRun
        self.agentSettings = agentSettings
        self.pullRequest = pullRequest
        self.pushedBranch = pushedBranch
        self.baseBranch = baseBranch
        self.agentMode = agentMode
        self.isResponding = isResponding
    }
}
