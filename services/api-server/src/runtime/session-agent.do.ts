import {
  type ClientState,
  type Logger,
  type Result,
  type SessionSetupRun,
  ClientMessage as ClientMessageSchema,
  type ClientMessage,
  type ServerMessage,
  AgentSettings,
  DEFAULT_AGENT_SETTINGS,
  failure,
  success,
} from "@repo/shared";
import type { Env } from "@/shared/types";
import { Agent, type Connection } from "agents";
import type { SpriteLifecycleClient } from "@repo/sprites-client";
import type { SecretRepository } from
  "@/modules/session-agent/repositories/secret.repository";
import type { ServerStateRepository, ServerState } from
  "@/modules/session-agent/repositories/server-state.repository";
import type { SessionEnvironmentSnapshotRepository } from
  "@/modules/session-agent/repositories/session-environment-snapshot.repository";
import { createLogger, initializeLogger } from "@/shared/logging";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  HandleDeleteSessionResult,
  HandleCreatePullRequestResult,
  HandleGetMessagesResult,
  HandleGetPlanResult,
  HandleGetSessionResult,
  HandleGetSetupOutputResult,
  HandleInitResult,
  HandleUpdatePullRequestResult,
  InitSessionAgentRequest,
  SessionAgentRpc,
  UpdatePullRequestRequest,
} from "@/shared/types/session-agent";
import { buildUserUiMessage } from "@/shared/utils/build-user-message";
import { timingSafeCompare } from "@/shared/utils/crypto";
import { sanitizeGitBranchName } from "@/shared/utils/git-branch";
import type {
  AgentEvent,
  SessionStatus,
  LogLevel,
  ChatMessageEvent,
} from "@repo/shared";
import type {
  AgentTurnCoordinator,
  FinishedAssistantTurn,
} from
  "@/modules/session-agent/services/agent-turn-coordinator.service";
import type { SpriteAgentProcessManager } from
  "@/modules/session-agent/services/agent-process/sprite-agent-process-manager.service";
import type {
  ChatDispatchError,
  ClaimedTurn,
  PreparedChatMessage,
  SessionChatDispatchService,
} from "@/modules/session-agent/services/session-chat-dispatch.service";
import type { SessionConnectorService } from
  "@/modules/session-agent/services/session-connector.service";
import type { SessionGitProxyService } from
  "@/modules/session-agent/services/session-git-proxy.service";
import type { SessionProviderConnectionService } from
  "@/modules/session-agent/services/session-provider-connection.service";
import type { RuntimeMigrationCoordinator } from
  "@/modules/session-agent/services/runtime-migration-coordinator.service";
import type { SessionProvisionService } from
  "@/modules/session-agent/services/session-provision.service";
import type { SessionQueryService } from
  "@/modules/session-agent/services/session-query.service";
import type { SessionSetupRunService } from
  "@/modules/session-agent/services/session-setup-run.service";
import type { SessionSummaryService } from
  "@/modules/session-agent/services/session-summary.service";
import type { SessionSyncService } from
  "@/modules/session-agent/services/session-sync.service";
import { normalizePullRequestState } from "@/modules/session-agent/utils/session-agent-pull-request-state.utils";
import { synthesizeSessionStatus } from "@/modules/session-agent/utils/session-status.utils";
import {
  RuntimeBoundaryMutex,
  type RuntimeBoundaryLease,
} from "./runtime-boundary-mutex";
import { getInitialClientState } from "@/modules/session-agent/utils/initial-client-state.utils";
import type { SessionAgentAttachmentProvider } from "./session-agent-attachment-provider";
import type { SessionAutoPullRequestService } from
  "./session-auto-pull-request.service";
import type { SessionPullRequestLifecycleService } from
  "./session-pull-request-lifecycle.service";
import type { SessionRepoAccessLifecycleService } from
  "./session-repo-access-lifecycle.service";
import type { SessionTurnNotificationService } from
  "./session-turn-notification.service";
import {
  createSessionAgentDependencies,
  createSessionAgentRepositories,
  type SessionAgentDependencies,
} from "./session-agent-dependencies";

type EnsureReadyOutcome =
  | { outcome: "ready" }
  | { outcome: "setup_incomplete" }
  | { outcome: "deferred_active_turn" };

type EnsureReadyError = {
  code:
    | "SESSION_NOT_INITIALIZED"
    | "INITIALIZATION_FAILED"
    | "PROVISIONING_FAILED"
    | "RUNTIME_MIGRATION_FAILED";
  message: string;
};

type EnsureReadyResult = Result<EnsureReadyOutcome, EnsureReadyError>;

type ChatAdmissionError = {
  code: "READINESS_FAILED" | "TURN_CONFLICT";
  message: string;
};

type ChatAdmissionResult = Result<void, ChatAdmissionError | ChatDispatchError>;

type ReadyTurnAdmission = {
  source: "pending" | "prepared";
  turn: ClaimedTurn;
};

interface AgentStateInternalAccess {
  _setStateInternal(state: ClientState, source: Connection | "server"): unknown;
}
export class SessionAgentDO extends Agent<Env, ClientState> implements SessionAgentRpc {
  private readonly logger: Logger;
  private readonly spriteLifecycleClient: SpriteLifecycleClient;
  private readonly secretRepository: SecretRepository;
  private readonly serverStateRepository: ServerStateRepository;
  private readonly environmentSnapshotRepository: SessionEnvironmentSnapshotRepository;
  private readonly attachmentService: SessionAgentAttachmentProvider;
  /** In-memory ServerState mirror — written through via updateServerState() */
  private serverState: ServerState;
  private readonly turnCoordinator: AgentTurnCoordinator;
  private readonly processManager: SpriteAgentProcessManager;
  private readonly runtimeMigrationCoordinator: RuntimeMigrationCoordinator;
  private readonly buildRuntimeMigrationContext:
    SessionAgentDependencies["buildRuntimeMigrationContext"];
  private readonly provisionService: SessionProvisionService;
  private readonly chatDispatchService: SessionChatDispatchService;
  private readonly setupRunService: SessionSetupRunService;
  private readonly providerConnectionService: SessionProviderConnectionService;
  private readonly sessionConnectorService: SessionConnectorService;
  private readonly gitProxyService: SessionGitProxyService;
  private readonly queryService: SessionQueryService;
  private readonly sessionSummaryService: SessionSummaryService;
  private readonly syncService: SessionSyncService;
  private readonly pullRequestLifecycleService: SessionPullRequestLifecycleService;
  private readonly repoAccessLifecycleService: SessionRepoAccessLifecycleService;
  private readonly autoPullRequestService: SessionAutoPullRequestService;
  private readonly turnNotificationService: SessionTurnNotificationService;
  private readonly runtimeBoundaryMutex = new RuntimeBoundaryMutex();
  private initializeSessionStatePromise: Promise<HandleInitResult> | null = null;

  initialState: ClientState = getInitialClientState();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    initializeLogger({
      level: env.LOG_LEVEL as LogLevel,
      format: "pretty",
    });
    this.logger = createLogger("session-agent-do.ts");

    this.disableClientStateUpdates();

    // Local migrations and ServerState load must precede service construction.
    const repositories = createSessionAgentRepositories(
      this.sql.bind(this),
      ctx.storage,
    );
    this.secretRepository = repositories.secretRepository;
    this.serverStateRepository = repositories.serverStateRepository;
    this.environmentSnapshotRepository = repositories.environmentSnapshotRepository;
    this.serverState = this.serverStateRepository.get();

    const dependencies = createSessionAgentDependencies({
      env,
      logger: this.logger,
      repositories,
      host: {
        getServerState: () => this.serverState,
        getClientState: () => this.state,
        updateServerState: (partial) => this.updateServerState(partial),
        updatePartialState: (partial) => this.updatePartialState(partial),
        updateSetupRun: (setupRun) => this.updateSetupRun(setupRun),
        broadcastMessage: (message, without) =>
          this.broadcastMessage(message, without),
        sendMessageToConnection: (message, connectionId) =>
          this.sendMessageToConnection(message, connectionId),
        synthesizeStatus: () => this.synthesizeStatus(),
        cancelActiveTurnAndClearState: () => this.cancelActiveTurnAndClearState(),
        keepAliveWhile: (callback) => this.keepAliveWhile(callback),
        createPullRequest: () => this.handleCreatePullRequest(),
        enforceSessionAccessBlocked: (notifyClients) =>
          this.enforceSessionAccessBlocked(notifyClients),
        updateWorkingState: (state) =>
          this.sessionSummaryService.persistWorkingState(state),
        persistPushedBranch: (branch) =>
          this.sessionSummaryService.persistPushedBranch(branch),
        onTurnFinished: (turn) => this.handleTurnFinished(turn),
        onTurnSettled: () => this.startRuntimeReadinessAndDispatch(),
      },
    });
    this.spriteLifecycleClient = dependencies.spriteLifecycleClient;
    this.attachmentService = dependencies.attachmentService;
    this.turnCoordinator = dependencies.turnCoordinator;
    this.processManager = dependencies.processManager;
    this.runtimeMigrationCoordinator = dependencies.runtimeMigrationCoordinator;
    this.buildRuntimeMigrationContext = dependencies.buildRuntimeMigrationContext;
    this.provisionService = dependencies.provisionService;
    this.chatDispatchService = dependencies.chatDispatchService;
    this.setupRunService = dependencies.setupRunService;
    this.providerConnectionService = dependencies.providerConnectionService;
    this.sessionConnectorService = dependencies.sessionConnectorService;
    this.gitProxyService = dependencies.gitProxyService;
    this.queryService = dependencies.queryService;
    this.sessionSummaryService = dependencies.sessionSummaryService;
    this.syncService = dependencies.syncService;
    this.pullRequestLifecycleService = dependencies.pullRequestLifecycleService;
    this.repoAccessLifecycleService = dependencies.repoAccessLifecycleService;
    this.autoPullRequestService = dependencies.autoPullRequestService;
    this.turnNotificationService = dependencies.turnNotificationService;

    this.logger.info("Constructed agent DO", {
      fields: { sessionId: this.serverState.sessionId },
    });
  }

  async onStart(): Promise<void> {
    // NOTE: doing this here brecause we cant access this.name in the constructor. cf bug
    // Reset transient ClientState fields on every restart so they never get
    // stuck from a previous instance's in-progress operation.
    this.setupRunService.repairOnStart();
    this.updatePartialState({
      status: this.synthesizeStatus(),
      lastError: null,
      pullRequest: normalizePullRequestState(this.state.pullRequest),
      activeTurn: this.serverState.activeUserMessageId
        ? { userMessageId: this.serverState.activeUserMessageId }
        : null,
    });
    this.logger.debug("onStart");
  }

  private disableClientStateUpdates(): void {
    // The Agents SDK allows clients to overwrite state via { type: "cf_agent_state" } WebSocket messages.
    // There is no validation hook before the write, so we intercept at _setStateInternal.
    // When source is a Connection (client), we reject the update entirely.
    const stateInternalAccess = this as unknown as AgentStateInternalAccess;
    const superSetStateInternal = stateInternalAccess._setStateInternal.bind(this);
    stateInternalAccess._setStateInternal = (
      state: ClientState,
      source: Connection | "server",
    ) => {
      if (source !== "server") {
        this.logger.warn("Rejecting client-initiated state update attempt");
        return;
      }
      return superSetStateInternal(state, source);
    };
  }

  // State helpers
  private updatePartialState(partial: Partial<ClientState>): void {
    this.setState({ ...this.state, ...partial });
  }

  private updateSetupRun(setupRun: SessionSetupRun): void {
    const previousStatus = this.state.status;
    const status = this.synthesizeStatus(setupRun);
    this.updatePartialState({ sessionSetupRun: setupRun, status });
    if (status !== previousStatus) {
      this.sessionSummaryService.persistStatus(status);
    }
  }

  private updateServerState(partial: Partial<ServerState>): void {
    this.serverState = { ...this.serverState, ...partial };
    this.serverStateRepository.update(partial);
  }

  private synthesizeStatus(setupRun?: SessionSetupRun | null): SessionStatus {
    return synthesizeSessionStatus({
      initialized: this.serverState.initialized,
      setupRun: setupRun === undefined ? this.state.sessionSetupRun : setupRun,
    });
  }

  private handleTurnFinished(turn: FinishedAssistantTurn): void {
    const summaryPersistence = this.sessionSummaryService.persistAssistantTurnFinished({
      messageId: turn.message.id,
      messageCreatedAt: turn.messageCreatedAt,
      aborted: turn.aborted,
    });
    if (turn.aborted) {
      return;
    }
    void summaryPersistence
      .then(() => this.publishTurnFinishedNotification(turn.message))
      .catch((error: unknown) => {
        this.logger.error("Failed to enqueue turn finished notification", {
          fields: {
            sessionId: this.serverState.sessionId,
            userId: this.serverState.userId,
            messageId: turn.message.id,
          },
          error,
        });
      });
    this.autoPullRequestService.queueCreateAfterTurnFinish();
  }

  private async publishTurnFinishedNotification(message: UIMessage): Promise<void> {
    const sessionId = this.serverState.sessionId;
    const userId = this.serverState.userId;
    const repoFullName = this.state.repoFullName;
    const messageId = message.id;
    if (!sessionId || !userId || !repoFullName) {
      this.logger.warn("Skipping turn finished notification with missing session state", {
        fields: {
          sessionId,
          userId,
          repoFullName,
          messageId,
        },
      });
      return;
    }

    await this.turnNotificationService.publishTurnFinished({
      toUserId: userId,
      sessionId,
      messageId,
      repoFullName,
      message,
    });
  }

  /**
   * RPC entry point: refreshes the cached provider connection state.
   * Called externally via DO stub from `refreshSessionProviderConnection`.
   */
  async refreshProviderConnection(): Promise<void> {
    await this.providerConnectionService.refresh();
  }

  // Webhook RPC handlers (called from /internal webhook routes)

  private isWebhookTokenValid(token: string): boolean {
    const expected = this.secretRepository.get("webhook_token");
    if (!expected) {
      this.logger.warn("Webhook auth failed: no webhook token stored");
      return false;
    }
    const ok = timingSafeCompare(expected, token);
    if (!ok) { this.logger.warn("Webhook auth failed: token mismatch"); }
    return ok;
  }

  /**
   * Webhook entry point for streamed chunks. The batch is applied in order;
   * a terminal chunk in the batch finalizes the turn.
   */
  async handleWebhookChunks(
    token: string,
    userMessageId: string,
    chunks: Array<{ sequence: number; chunk: UIMessageChunk }>,
  ): Promise<boolean> {
    if (!this.isWebhookTokenValid(token)) {
      return false;
    }

    this.logger.info("handleWebhookChunks", {
      fields: {
        userMessageId,
        chunkCount: chunks.length,
        activeUserMessageId: this.serverState.activeUserMessageId,
      },
    });
    this.turnCoordinator.ensureRehydratedState();
    await this.turnCoordinator.handleChunks(userMessageId, chunks);
    return true;
  }

  /**
   * Webhook entry point for non-stream agent events. Dispatches on the
   * AgentEvent discriminator.
   */
  handleWebhookEvent(token: string, event: AgentEvent): boolean {
    if (!this.isWebhookTokenValid(token)) {
      return false;
    }

    this.logger.info("handleWebhookEvent", {
      fields: { eventType: event.type },
    });
    this.turnCoordinator.handleEvent(event);
    return true;
  }

  mintEphemeralGitToken(webhookToken: string): { token: string; expiresAt: number } | null {
    if (!this.isWebhookTokenValid(webhookToken)) {
      return null;
    }
    return this.gitProxyService.mintEphemeralGitToken();
  }
  // HTTP/RPC Handlers

  /**
   * RPC entry point for the `/git-proxy/:sessionId/*` route. Handles repo
   * access checks, forwards the git request to GitHub, and propagates any
   * resulting token refresh or pushed-branch update into session state.
   */
  async handleGitProxy(request: Request): Promise<Response> {
    return this.gitProxyService.handleRequest(request);
  }

  // WebSocket lifecycle (Agents SDK)

  onConnect(connection: Connection): void {
    this.logger.debug("Client connected", {
      fields: { connectionId: connection.id },
    });
    this.turnCoordinator.ensureRehydratedState();

    // Send initial connection state
    this.sendMessage(this.syncService.buildConnectedMessage(), connection);

    // Send message history
    if (this.serverState.sessionId) {
      this.sendMessage(this.syncService.buildSyncResponse(), connection);
    }

    // Always call ensureReady — idempotent, skips completed steps via serverState checkpoints
    this.startRuntimeReadinessAndDispatch();
    this.providerConnectionService.queueRefresh();
  }

  async onMessage(
    connection: Connection,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const messageStr =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    let messageData: unknown;
    try {
      messageData = JSON.parse(messageStr);
    } catch (error) {
      this.logger.error("Ignored non-JSON websocket message", {
        error,
        fields: {
          connectionId: connection.id,
          preview: messageStr.slice(0, 200),
        },
      });
      return;
    }

    const parsedMessage = ClientMessageSchema.safeParse(messageData);
    if (!parsedMessage.success) {
      this.logger.error("Invalid websocket message payload", {
        fields: {
          connectionId: connection.id,
          preview: messageStr.slice(0, 200),
          issues: parsedMessage.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      this.sendMessage(
        {
          type: "operation.error",
          code: "INVALID_MESSAGE",
          message: "unknown request",
        },
        connection,
      );
      return;
    }

    try {
      await this.handleClientMessage(connection, parsedMessage.data);
    } catch (error) {
      this.logger.error("Failed to handle websocket message", {
        error,
        fields: {
          connectionId: connection.id,
          type: parsedMessage.data.type,
        },
      });
      this.sendMessage(
        {
          type: "operation.error",
          code: "MESSAGE_HANDLER_ERROR",
          message: "request failed",
        },
        connection,
      );
    }
  }

  onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    this.logger.debug("WebSocket closed", {
      fields: {
        connectionId: connection.id,
        code,
        reason,
        wasClean,
      },
    });
  }

  onError(connectionOrError: Connection | unknown, error?: unknown): void {
    this.logger.error("WebSocket error", {
      error: error ?? connectionOrError,
    });
  }

  // Provisioning
  /** Runs readiness, then synchronously admits pending work before prepared work. */
  private async admitNextTurn(
    prepared?: PreparedChatMessage,
  ): Promise<{
    readiness: EnsureReadyResult;
    admission: ReadyTurnAdmission | null;
  }> {
    return this.runtimeBoundaryMutex.runExclusive(async (lease) => {
      this.chatDispatchService.recoverInterruptedClaim();
      const readiness = await this._ensureReady(lease);
      let admission: ReadyTurnAdmission | null = null;
      if (readiness.ok && readiness.value.outcome === "ready") {
        const pendingTurn = this.chatDispatchService.claimPendingMessage();
        if (pendingTurn) {
          admission = { source: "pending", turn: pendingTurn };
        } else if (
          prepared &&
          !this.serverState.activeUserMessageId &&
          !this.state.pendingUserMessage
        ) {
          admission = {
            source: "prepared",
            turn: this.chatDispatchService.claimPreparedMessage(prepared),
          };
        }
      }
      return { readiness, admission };
    });
  }

  /** Keeps the complete readiness, admission, and post-boundary dispatch alive. */
  private async ensureRuntimeReadyAndDispatchNextTurn(): Promise<
    EnsureReadyResult
  >;
  private async ensureRuntimeReadyAndDispatchNextTurn(
    prepared: PreparedChatMessage,
  ): Promise<ChatAdmissionResult>;
  private async ensureRuntimeReadyAndDispatchNextTurn(
    prepared?: PreparedChatMessage,
  ): Promise<EnsureReadyResult | ChatAdmissionResult> {
    return this.keepAliveWhile(async () => {
      const boundary = await this.admitNextTurn(prepared);
      let dispatchResult: Result<void, ChatDispatchError> | null = null;
      if (boundary.admission) {
        dispatchResult = await this.chatDispatchService.spawnClaimedTurn(
          boundary.admission.turn,
        );
        if (boundary.admission.source === "pending" && !dispatchResult.ok) {
          this.logger.error("Failed to dispatch pending message", {
            fields: { code: dispatchResult.error.code },
            error: dispatchResult.error.message,
          });
        }
      }

      if (!prepared) {
        return boundary.readiness;
      }
      if (!boundary.readiness.ok) {
        return failure({
          code: "READINESS_FAILED",
          message: boundary.readiness.error.message,
        });
      }
      if (boundary.readiness.value.outcome !== "ready") {
        return failure({
          code: "READINESS_FAILED",
          message: boundary.readiness.value.outcome === "deferred_active_turn"
            ? "Agent is already handling a message"
            : "Session setup is not complete",
        });
      }
      if (boundary.admission?.source !== "prepared") {
        return failure({
          code: "TURN_CONFLICT",
          message: "Agent is already handling a message",
        });
      }
      return dispatchResult ?? success(undefined);
    });
  }

  /** Runs readiness stages while the caller owns the runtime boundary.
   * The _lease is just to ensure this is only called within a mutex
   * and not independently
   */
  private async _ensureReady(
    _lease: RuntimeBoundaryLease,
  ): Promise<EnsureReadyResult> {
    if (!this.serverState.initialized) {
      const initResult = await this.initializeSessionStatePromise;
      if (!initResult) {
        return failure({
          code: "SESSION_NOT_INITIALIZED",
          message: "Session is not initialized",
        });
      }
      if (!initResult.ok) {
        return failure({
          code: "INITIALIZATION_FAILED",
          message: initResult.error.message,
        });
      }
    }

    if (this.serverState.teardownStarted) {
      return failure({
        code: "RUNTIME_MIGRATION_FAILED",
        message: "Runtime readiness cannot begin during session teardown",
      });
    }

    try {
      await this.provisionService.ensureProvisioned(_lease);
    } catch (error) {
      return failure({
        code: "PROVISIONING_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.state.sessionSetupRun?.status !== "completed") {
      return success({ outcome: "setup_incomplete" });
    }

    if (this.serverState.activeUserMessageId !== null) {
      return success({ outcome: "deferred_active_turn" });
    }

    if (!this.serverState.spriteName) {
      return failure({
        code: "PROVISIONING_FAILED",
        message: "Sprite name is missing after completed setup",
      });
    }
    const migrations = await this.runtimeMigrationCoordinator.ensureMigrations(
      this.buildRuntimeMigrationContext(this.serverState.spriteName),
      _lease,
    );
    if (!migrations.ok) {
      return failure({
        code: "RUNTIME_MIGRATION_FAILED",
        message: migrations.error.message,
      });
    }
    const outcome = migrations.value.outcome;
    switch (outcome) {
      case "current":
      case "applied":
        return success({ outcome: "ready" });
      case "deferred_active_turn":
        return success({ outcome: "deferred_active_turn" });
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled runtime migration outcome: ${exhaustiveCheck}`);
      }
    }
  }

  /**
   * Starts the runtime readiness and dispatch process asynchronously
   */
  private startRuntimeReadinessAndDispatch(): void {
    void this.ensureRuntimeReadyAndDispatchNextTurn()
      .then((readiness) => {
        if (!readiness.ok) {
          this.logger.warn("Runtime readiness and dispatch did not complete", {
            fields: { code: readiness.error.code },
          });
        }
      })
      .catch((error) => {
        this.logger.error("Runtime readiness and dispatch failed unexpectedly", {
          error,
        });
      });
  }

  // Init handler

  async handleInit(request: InitSessionAgentRequest): Promise<HandleInitResult> {
    // prevents other networking code from running while initializing
    const initPromise = this.ctx.blockConcurrencyWhile(
      () => this.initializeSessionState(request),
    );
    this.initializeSessionStatePromise = initPromise;
    try {
      const initResult = await initPromise;
      if (initResult.ok) {
        this.startRuntimeReadinessAndDispatch();
      }
      return initResult;
    } finally {
      if (this.initializeSessionStatePromise === initPromise) {
        this.initializeSessionStatePromise = null;
      }
    }
  }

  private async initializeSessionState(
    request: InitSessionAgentRequest,
  ): Promise<HandleInitResult> {
    // Prevent re-initialization
    if (this.serverState.initialized) {
      this.logger.error(
        "Session already initialized — refusing to re-initialize",
        {
          fields: { sessionId: this.serverState.sessionId },
        },
      );
      return failure({ code: "ALREADY_INITIALIZED", message: "Session already initialized", status: 400 });
    }

    const data = request;
    const provider = data.agentSettings?.provider ?? DEFAULT_AGENT_SETTINGS.provider;
    const maxTokens = data.agentSettings?.maxTokens ?? DEFAULT_AGENT_SETTINGS.maxTokens;

    let settings: AgentSettings;
    const parsed = AgentSettings.safeParse({
      provider,
      model: data.agentSettings?.model,
      effort: data.agentSettings?.effort,
      maxTokens,
    });
    if (parsed.success) {
      settings = parsed.data;
    } else {
      this.logger.warn("Invalid agent settings — falling back to provider defaults", {
        fields: { provider },
      });
      settings = AgentSettings.parse({ provider, maxTokens });
    }
    // TODO: use blockConcurrencyWhile?
    const providerConnection = await this.providerConnectionService.resolveState(
      settings.provider,
      data.userId,
    );

    const pendingAttachmentIds = data.initialMessage.attachmentIds ?? [];
    const pendingUserUiMessage = await buildUserUiMessage(
      data.sessionId,
      data.initialMessage,
      {
        attachmentService: this.attachmentService,
      },
    );
    // the setup run tasks are frozen at init time.
    // later changes to the run do not affect the frozen task list,
    // and older sessions should use migrations to ensure they are up to date.
    const sessionSetupRun = this.setupRunService.buildRun();

    // Mark initialized in ServerState
    this.updateServerState({
      initialized: true,
      sessionId: data.sessionId,
      userId: data.userId,
    });
    this.environmentSnapshotRepository.set(data.environmentSnapshot);

    // Store the durable initial fields in ClientState
    this.updatePartialState({
      repoFullName: data.repoFullName,
      agentSettings: settings,
      providerConnection,
      agentMode: data.agentMode ?? "edit",
      pendingUserMessage: {
        message: pendingUserUiMessage,
        attachmentIds: pendingAttachmentIds,
      },
      // Store the requested base branch; cloneRepo will detect the actual branch and overwrite.
      baseBranch: sanitizeGitBranchName(data.branch),
      sessionSetupRun,
      status: this.synthesizeStatus(sessionSetupRun),
    });

    return success(undefined);
  }

  // Session info / management handlers

  handleGetSession(): HandleGetSessionResult {
    return this.queryService.handleGetSession();
  }

  handleGetMessages(): HandleGetMessagesResult {
    return this.queryService.handleGetMessages();
  }

  handleGetPlan(): HandleGetPlanResult {
    return this.queryService.handleGetPlan();
  }

  handleGetSetupOutput(): HandleGetSetupOutputResult {
    return this.queryService.handleGetSetupOutput();
  }

  async handleCreatePullRequest(): Promise<HandleCreatePullRequestResult> {
    return this.pullRequestLifecycleService.handleCreatePullRequest();
  }

  async updatePullRequest(data: UpdatePullRequestRequest): Promise<HandleUpdatePullRequestResult> {
    return this.pullRequestLifecycleService.updatePullRequest(data);
  }

  async handleDeleteSession(): Promise<HandleDeleteSessionResult> {
    this.updateServerState({ teardownStarted: true });
    // Force-kill any running vm-agent process before we tear down the sprite.
    try {
      await this.processManager.kill();
    } catch (error) {
      this.logger.warn("Failed to kill vm-agent on session delete", { error });
    }

    // Revoke short-lived Git authority and connector mint authority before
    // potentially slow external cleanup.
    this.gitProxyService.revokeEphemeralGitTokens();
    this.secretRepository.delete("webhook_token");

    // Delete the session's internal connector. Never throws; a failed delete
    // leaves the D1 record in pending_revocation for reconciliation.
    await this.sessionConnectorService.deleteForTeardown();

    // Clean up sprite
    if (this.serverState.spriteName) {
      try {
        await this.spriteLifecycleClient.deleteSprite(this.serverState.spriteName);
      } catch (error) {
        this.logger.error("Failed to delete sprite", { error });
      }
    }

    // Clear Agent SDK state, alarms, WebSocket resources, and all DO storage.
    await this.destroy();

    return success(undefined);
  }

  // Client message handlers

  private async handleClientMessage(
    connection: Connection,
    message: ClientMessage,
  ): Promise<void> {
    this.turnCoordinator.ensureRehydratedState();
    switch (message.type) {
      case "chat.message":
        await this.handleUserChatMessage(connection, message);
        break;
      case "sync.request":
        await this.handleSyncRequest(connection);
        break;
      case "session.mark_read":
        await this.handleMarkRead(message.messageId);
        break;
      case "operation.cancel":
        await this.cancelActiveTurnAndClearState();
        break;
    }
  }

  private async handleUserChatMessage(
    connection: Connection,
    payload: ChatMessageEvent,
  ): Promise<void> {
    try {
      const accessGuard = await this.repoAccessLifecycleService.guardSessionRepoAccess();
      if (!accessGuard.ok) {
        this.sendMessage(accessGuard.message, connection);
        return;
      }

      const prepared = await this.chatDispatchService.prepareChatMessage(
        payload,
        connection.id,
      );
      if (!prepared.ok) {
        this.sendChatFailure(connection, prepared.error.message);
        return;
      }

      const admission = await this.ensureRuntimeReadyAndDispatchNextTurn(
        prepared.value,
      );
      if (!admission.ok) {
        this.sendChatFailure(connection, admission.error.message);
        return;
      }
    } catch (error) {
      this.logger.error("Failed to handle chat message", { error });
      this.sendMessage(
        {
          type: "operation.error",
          code: "CHAT_MESSAGE_FAILED",
          message: "Failed to handle chat message",
        },
        connection,
      );
    }
  }

  private sendChatFailure(connection: Connection, message: string): void {
    this.sendMessage(
      {
        type: "operation.error",
        code: "CHAT_MESSAGE_FAILED",
        message,
      },
      connection,
    );
  }

  private async handleSyncRequest(connection: Connection): Promise<void> {
    const accessGuard = await this.repoAccessLifecycleService.guardSessionRepoAccess();
    if (!accessGuard.ok) {
      this.sendMessage(accessGuard.message, connection);
      return;
    }

    this.sendMessage(this.syncService.buildSyncResponse(), connection);
  }

  private async handleMarkRead(messageId: string): Promise<void> {
    await this.sessionSummaryService.markRead(messageId);
  }

  private async cancelActiveTurnAndClearState(): Promise<void> {
    const result = await this.processManager.cancelActiveTurn();
    // Treat cancel as locally authoritative: a SIGTERM may not produce a
    // terminal abort chunk, but the user must be able to send the next turn.
    this.turnCoordinator.markTurnCanceled({
      preserveAgentProcessId: result.processPreserved,
    });
  }

  async enforceSessionAccessBlocked(notifyClients = true): Promise<void> {
    const message = await this.repoAccessLifecycleService.enforceSessionAccessBlocked(notifyClients);
    if (message) {
      this.broadcastMessage(message);
    }
  }

  // Broadcast / send helpers

  private broadcastMessage(message: ServerMessage, without?: string[]): void {
    let connectionCount = 0;
    try {
      connectionCount = Array.from(this.getConnections()).length;
    } catch {
      // getConnections may not be available in all contexts
    }
    this.logger.info("broadcastMessage", {
      fields: { type: message.type, connectionCount },
    });
    this.broadcast(JSON.stringify(message), without);
  }

  private sendMessageToConnection(message: ServerMessage, connectionId: string): void {
    const connection = Array.from(this.getConnections())
      .find((candidate) => candidate.id === connectionId);
    if (!connection) {
      this.logger.warn("Cannot send message to missing connection", {
        fields: { connectionId, type: message.type },
      });
      return;
    }
    this.sendMessage(message, connection);
  }

  private sendMessage(message: ServerMessage, to: Connection): void {
    to.send(JSON.stringify(message));
  }
}
