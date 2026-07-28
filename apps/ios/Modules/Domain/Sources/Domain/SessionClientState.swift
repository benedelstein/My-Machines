public struct SessionClientState: Sendable, Equatable, Codable {
    public static let empty = SessionClientState(
        repoFullName: nil,
        status: .preparing,
        sessionSetupRun: nil,
        agentSettings: AgentSettings(provider: .unknown(""), model: "", effort: "", maxTokens: 0),
        pullRequest: nil,
        pushedBranch: nil,
        baseBranch: nil,
        todos: nil,
        plan: nil,
        pendingUserMessage: nil,
        activeTurnUserMessageId: nil,
        editorURL: nil,
        providerConnection: nil,
        agentMode: .edit,
        lastError: nil,
        createdAt: ""
    )

    public var repoFullName: String?
    public var status: Status
    public var sessionSetupRun: SessionSetupRun?
    public var agentSettings: AgentSettings
    public var pullRequest: PullRequest?
    public var pushedBranch: String?
    public var baseBranch: String?
    public var todos: [Todo]?
    public var plan: Plan?
    public var pendingUserMessage: SessionMessage?
    public var activeTurnUserMessageId: String?
    public var editorURL: String?
    public var providerConnection: ProviderConnection?
    public var agentMode: AgentMode
    public var lastError: String?
    public var createdAt: String

    public init(
        repoFullName: String?,
        status: Status,
        sessionSetupRun: SessionSetupRun?,
        agentSettings: AgentSettings,
        pullRequest: PullRequest?,
        pushedBranch: String?,
        baseBranch: String?,
        todos: [Todo]?,
        plan: Plan?,
        pendingUserMessage: SessionMessage?,
        activeTurnUserMessageId: String?,
        editorURL: String?,
        providerConnection: ProviderConnection?,
        agentMode: AgentMode,
        lastError: String?,
        createdAt: String
    ) {
        self.repoFullName = repoFullName
        self.status = status
        self.sessionSetupRun = sessionSetupRun
        self.agentSettings = agentSettings
        self.pullRequest = pullRequest
        self.pushedBranch = pushedBranch
        self.baseBranch = baseBranch
        self.todos = todos
        self.plan = plan
        self.pendingUserMessage = pendingUserMessage
        self.activeTurnUserMessageId = activeTurnUserMessageId
        self.editorURL = editorURL
        self.providerConnection = providerConnection
        self.agentMode = agentMode
        self.lastError = lastError
        self.createdAt = createdAt
    }
}

public extension SessionClientState {
    /// The operational mode used for agent turns.
    enum AgentMode: RawRepresentable, Codable, Equatable, Sendable {
        case edit
        case plan
        case unknown(String)

        /// Creates an agent mode from its wire representation.
        public init(rawValue: String) {
            switch rawValue {
            case "edit": self = .edit
            case "plan": self = .plan
            default: self = .unknown(rawValue)
            }
        }

        /// The agent mode value used on the wire.
        public var rawValue: String {
            switch self {
            case .edit: "edit"
            case .plan: "plan"
            case .unknown(let value): value
            }
        }
    }

    /// The server-reported readiness of a session.
    enum Status: RawRepresentable, Codable, Equatable, Sendable {
        case preparing
        case setupFailed
        case ready
        case unknown(String)

        /// Creates a status from its wire representation.
        public init(rawValue: String) {
            switch rawValue {
            case "preparing": self = .preparing
            case "setup_failed": self = .setupFailed
            case "ready": self = .ready
            default: self = .unknown(rawValue)
            }
        }

        /// The status value used on the wire.
        public var rawValue: String {
            switch self {
            case .preparing: "preparing"
            case .setupFailed: "setup_failed"
            case .ready: "ready"
            case .unknown(let value): value
            }
        }
    }

    struct AgentSettings: Sendable, Equatable, Codable {
        public let provider: AgentProviderID
        public let model: String
        public let effort: String
        public let maxTokens: Int

        public init(provider: AgentProviderID, model: String, effort: String, maxTokens: Int) {
            self.provider = provider
            self.model = model
            self.effort = effort
            self.maxTokens = maxTokens
        }
    }

    struct Plan: Sendable, Equatable, Codable {
        public let lastUpdated: String

        public init(lastUpdated: String) {
            self.lastUpdated = lastUpdated
        }
    }

    struct ProviderConnection: Sendable, Equatable, Codable {
        public let provider: String
        public let connected: Bool
        public let requiresReauth: Bool

        public init(provider: String, connected: Bool, requiresReauth: Bool) {
            self.provider = provider
            self.connected = connected
            self.requiresReauth = requiresReauth
        }
    }

    struct Todo: Sendable, Equatable, Codable, Identifiable {
        public let id: String?
        public let content: String
        public let activeForm: String?
        public let status: String

        public init(id: String?, content: String, activeForm: String?, status: String) {
            self.id = id
            self.content = content
            self.activeForm = activeForm
            self.status = status
        }
    }

    enum PullRequest: Sendable, Equatable, Codable {
        case creating
        case failed(error: String, details: String?)
        case created(url: String, number: Int, state: String)
        case unknown(status: String)
    }

    struct SessionSetupRun: Sendable, Equatable, Codable {
        /// The lifecycle state of a session setup run.
        public enum Status: RawRepresentable, Codable, Equatable, Sendable {
            case running
            case completed
            case failed
            case unknown(String)

            /// Creates a status from its wire representation.
            public init(rawValue: String) {
                switch rawValue {
                case "running": self = .running
                case "completed": self = .completed
                case "failed": self = .failed
                default: self = .unknown(rawValue)
                }
            }

            /// The status value used on the wire.
            public var rawValue: String {
                switch self {
                case .running: "running"
                case .completed: "completed"
                case .failed: "failed"
                case .unknown(let value): value
                }
            }
        }

        public let id: String
        public let status: Status
        public let startedAt: String
        public let completedAt: String?
        public let tasks: [SessionSetupTask]

        public init(
            id: String,
            status: Status,
            startedAt: String,
            completedAt: String?,
            tasks: [SessionSetupTask]
        ) {
            self.id = id
            self.status = status
            self.startedAt = startedAt
            self.completedAt = completedAt
            self.tasks = tasks
        }
    }

    struct SessionSetupTask: Sendable, Equatable, Codable, Identifiable {
        /// A setup step reported by the session runtime.
        public enum TaskID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
            case cloudContainer
            case sessionConnector
            case repository
            case setupScript
            case networkPolicy
            case unknown(String)

            /// Creates a task identifier from its wire value.
            public init(rawValue: String) {
                switch rawValue {
                case "cloud_container": self = .cloudContainer
                case "session_connector": self = .sessionConnector
                case "repository": self = .repository
                case "setup_script": self = .setupScript
                case "network_policy": self = .networkPolicy
                default: self = .unknown(rawValue)
                }
            }

            /// The task identifier used on the wire.
            public var rawValue: String {
                switch self {
                case .cloudContainer: "cloud_container"
                case .sessionConnector: "session_connector"
                case .repository: "repository"
                case .setupScript: "setup_script"
                case .networkPolicy: "network_policy"
                case .unknown(let value): value
                }
            }
        }

        /// The lifecycle state of an individual setup step.
        public enum Status: RawRepresentable, Codable, Equatable, Sendable {
            case pending
            case running
            case completed
            case failed
            case skipped
            case unknown(String)

            /// Creates a task status from its wire value.
            public init(rawValue: String) {
                switch rawValue {
                case "pending": self = .pending
                case "running": self = .running
                case "completed": self = .completed
                case "failed": self = .failed
                case "skipped": self = .skipped
                default: self = .unknown(rawValue)
                }
            }

            /// The task status used on the wire.
            public var rawValue: String {
                switch self {
                case .pending: "pending"
                case .running: "running"
                case .completed: "completed"
                case .failed: "failed"
                case .skipped: "skipped"
                case .unknown(let value): value
                }
            }
        }

        /// Why the startup script did not run.
        public enum SkipReason: Sendable, Equatable, Codable {
            case noEnvironment(repoID: Int)
            case noScript(environmentID: String, environmentName: String?)
            case unknown(String)
        }

        public let id: TaskID
        public let status: Status
        public let startedAt: String?
        public let completedAt: String?
        public let error: String?
        public let isBlocking: Bool
        public let canRetry: Bool
        public let output: SessionSetupTaskOutput?
        public let skipReason: SkipReason?

        public init(
            id: TaskID,
            status: Status,
            startedAt: String?,
            completedAt: String?,
            error: String?,
            isBlocking: Bool,
            canRetry: Bool,
            output: SessionSetupTaskOutput?,
            skipReason: SkipReason? = nil
        ) {
            self.id = id
            self.status = status
            self.startedAt = startedAt
            self.completedAt = completedAt
            self.error = error
            self.isBlocking = isBlocking
            self.canRetry = canRetry
            self.output = output
            self.skipReason = skipReason
        }
    }

    struct SessionSetupTaskOutput: Sendable, Equatable, Codable {
        public let exitCode: Int?
        public let truncated: Bool
        public let stdoutLength: Int?
        public let stderrLength: Int?

        public init(exitCode: Int?, truncated: Bool, stdoutLength: Int?, stderrLength: Int?) {
            self.exitCode = exitCode
            self.truncated = truncated
            self.stdoutLength = stdoutLength
            self.stderrLength = stderrLength
        }
    }
}
