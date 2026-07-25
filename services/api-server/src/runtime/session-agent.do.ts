import { SpritesCoordinator } from "@repo/sprites-client";
import {
  type ClientState,
  type Logger,
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
import { MessageRepository } from "@/modules/session-agent/repositories/message.repository";
import { PendingChunkRepository } from "@/modules/session-agent/repositories/pending-chunk.repository";
import { SecretRepository } from "@/modules/session-agent/repositories/secret.repository";
import { LatestPlanRepository } from "@/modules/session-agent/repositories/latest-plan.repository";
import {
  ServerStateRepository,
  type ServerState,
} from "@/modules/session-agent/repositories/server-state.repository";
import { SessionEnvironmentSnapshotRepository } from "@/modules/session-agent/repositories/session-environment-snapshot.repository";
import { SetupOutputRepository } from "@/modules/session-agent/repositories/setup-output.repository";
import { migrateAll } from "@/modules/session-agent/repositories/schema-manager.repository";
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
import { AgentTurnCoordinator } from "@/modules/session-agent/services/agent-turn-coordinator.service";
import { SessionProvisionService } from "@/modules/session-agent/services/session-provision.service";
import { SessionChatDispatchService } from "@/modules/session-agent/services/session-chat-dispatch.service";
import { SessionSetupRunService } from "@/modules/session-agent/services/session-setup-run.service";
import { SessionSetupOutputService } from "@/modules/session-agent/services/session-setup-output.service";
import { SessionProviderConnectionService } from "@/modules/session-agent/services/session-provider-connection.service";
import { SessionGitProxyService } from "@/modules/session-agent/services/session-git-proxy.service";
import { SessionQueryService } from "@/modules/session-agent/services/session-query.service";
import { SessionSummaryService } from "@/modules/session-agent/services/session-summary.service";
import { SessionSyncService } from "@/modules/session-agent/services/session-sync.service";
import { getProviderAuthService } from "@/modules/ai-auth/services/provider-auth.service";
import { getProviderCredentialAdapter } from "@/modules/ai-auth/services/provider-credential-adapter.service";
import { GitHubAppService } from "@/modules/github/services/github-app.service";
import { SessionsRepository } from "@/modules/sessions/repositories/sessions.repository";
import { createSessionSummaryWriter } from "@/modules/sessions/services/session-access.service";
import { createPullRequestForSessionContext } from "@/modules/sessions/services/session-pull-request.service";
import { createUserSessionsPublisher } from "@/modules/sessions/services/user-sessions-publisher.service";
import { NotificationPublisher } from "@/modules/notifications/services/notification-publisher.service";
import { SessionAgentAttachmentProvider } from "./session-agent-attachment-provider";
import { SpriteAgentProcessManager } from "@/modules/session-agent/services/agent-process/sprite-agent-process-manager.service";
import { normalizePullRequestState } from "@/modules/session-agent/utils/session-agent-pull-request-state.utils";
import { SessionAutoPullRequestService } from "./session-auto-pull-request.service";
import { SessionPullRequestLifecycleService } from "./session-pull-request-lifecycle.service";
import { SessionRepoAccessLifecycleService } from "./session-repo-access-lifecycle.service";
import { SessionTurnNotificationService } from "./session-turn-notification.service";

interface AgentStateInternalAccess {
  _setStateInternal(state: ClientState, source: Connection | "server"): unknown;
}

export class SessionAgentDO extends Agent<Env, ClientState> implements SessionAgentRpc {
  private readonly logger: Logger;
  private readonly spritesCoordinator: SpritesCoordinator;
  private readonly messageRepository: MessageRepository;
  private readonly secretRepository: SecretRepository;
  private readonly latestPlanRepository: LatestPlanRepository;
  private readonly serverStateRepository: ServerStateRepository;
  private readonly environmentSnapshotRepository: SessionEnvironmentSnapshotRepository;
  private readonly pendingChunkRepository: PendingChunkRepository;
  private readonly setupOutputRepository: SetupOutputRepository;
  private readonly attachmentService: SessionAgentAttachmentProvider;
  /** In-memory ServerState mirror — written through via updateServerState() */
  private serverState: ServerState;
  private readonly turnCoordinator: AgentTurnCoordinator;
  private readonly processManager: SpriteAgentProcessManager;
  private readonly provisionService: SessionProvisionService;
  private readonly chatDispatchService: SessionChatDispatchService;
  private readonly setupRunService: SessionSetupRunService;
  private readonly setupOutputService: SessionSetupOutputService;
  private readonly providerConnectionService: SessionProviderConnectionService;
  private readonly gitProxyService: SessionGitProxyService;
  private readonly queryService: SessionQueryService;
  private readonly sessionSummaryService: SessionSummaryService;
  private readonly syncService: SessionSyncService;
  private readonly githubAppService: GitHubAppService;
  private readonly pullRequestLifecycleService: SessionPullRequestLifecycleService;
  private readonly repoAccessLifecycleService: SessionRepoAccessLifecycleService;
  private readonly autoPullRequestService: SessionAutoPullRequestService;
  private readonly notificationPublisher: NotificationPublisher;
  private readonly turnNotificationService: SessionTurnNotificationService;
  private initializeSessionStatePromise: Promise<HandleInitResult> | null = null;

  initialState: ClientState = {
    repoFullName: null,
    status: "preparing",
    sessionSetupRun: null,
    agentSettings: { ...DEFAULT_AGENT_SETTINGS },
    agentMode: "edit",
    pushedBranch: null,
    pullRequest: null,
    todos: null,
    plan: null,
    pendingUserMessage: null,
    activeTurn: null,
    editorUrl: null,
    providerConnection: null,
    lastError: null,
    baseBranch: null,
    createdAt: new Date().toISOString(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    initializeLogger({
      level: env.LOG_LEVEL as LogLevel,
      format: "pretty",
    });
    this.logger = createLogger("session-agent-do.ts");

    this.disableClientStateUpdates();

    const sql = this.sql.bind(this);
    this.messageRepository = new MessageRepository(sql);
    this.secretRepository = new SecretRepository(sql);
    this.latestPlanRepository = new LatestPlanRepository(sql);
    this.serverStateRepository = new ServerStateRepository(sql);
    this.environmentSnapshotRepository = new SessionEnvironmentSnapshotRepository(sql);
    this.pendingChunkRepository = new PendingChunkRepository(sql);
    this.setupOutputRepository = new SetupOutputRepository(sql);
    this.setupOutputService = new SessionSetupOutputService({
      logger: this.logger,
      repository: this.setupOutputRepository,
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });
    this.spritesCoordinator = new SpritesCoordinator({
      apiKey: this.env.SPRITES_API_KEY,
      logger: createLogger("sprites.ts"),
    });
    this.attachmentService = new SessionAgentAttachmentProvider(this.env.DB);
    this.githubAppService = new GitHubAppService(this.env, this.logger);
    this.notificationPublisher = new NotificationPublisher(this.env);
    this.turnNotificationService = new SessionTurnNotificationService({
      notificationPublisher: this.notificationPublisher,
      sessionsRepository: new SessionsRepository(this.env.DB),
    });
    const userSessionsPublisher = createUserSessionsPublisher(
      this.env,
      this.logger.scope("user-sessions-publisher"),
    );
    this.sessionSummaryService = new SessionSummaryService({
      repository: createSessionSummaryWriter(this.env),
      getSessionId: () => this.serverState.sessionId,
      getUserId: () => this.serverState.userId,
      publishSessionSummaryInvalidated: (userId, sessionId) =>
        userSessionsPublisher.invalidateSessionSummary({ userId, sessionId }),
      logger: this.logger,
    });
    this.queryService = new SessionQueryService({
      messageRepository: this.messageRepository,
      latestPlanRepository: this.latestPlanRepository,
      setupOutputRepository: this.setupOutputRepository,
      getSetupOutputEpoch: () => this.setupOutputService.getEpoch(),
      getServerState: () => this.serverState,
      getClientState: () => this.state,
    });
    this.pullRequestLifecycleService = new SessionPullRequestLifecycleService({
      logger: this.logger,
      github: this.githubAppService,
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      webOrigin: this.env.WEB_ORIGIN,
      createPullRequest: createPullRequestForSessionContext,
      messageRepository: this.messageRepository,
      sessionSummaryService: this.sessionSummaryService,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      setPullRequestClientState: (pullRequest) =>
        this.updatePartialState({ pullRequest }),
    });
    this.repoAccessLifecycleService = new SessionRepoAccessLifecycleService({
      logger: this.logger,
      env: this.env,
      getServerState: () => this.serverState,
      updatePartialState: (partial) => this.updatePartialState(partial),
      cancelActiveTurnAndClearState: () => this.cancelActiveTurnAndClearState(),
      killActiveProcess: () => this.processManager.kill(),
    });
    this.autoPullRequestService = new SessionAutoPullRequestService({
      logger: this.logger,
      createPullRequest: () => this.handleCreatePullRequest(),
      getState: () => ({
        sessionId: this.serverState.sessionId,
        repoFullName: this.state.repoFullName,
        pushedBranch: this.state.pushedBranch,
        pullRequestStatus: this.state.pullRequest?.status ?? null,
      }),
      keepAliveWhile: (callback) => this.keepAliveWhile(callback),
      assertSessionRepoAccess: () =>
        this.repoAccessLifecycleService.assertSessionRepoAccess(),
      enforceSessionAccessBlocked: () => this.enforceSessionAccessBlocked(false),
    });

    migrateAll(sql, ctx.storage, [
      this.messageRepository,
      this.secretRepository,
      this.latestPlanRepository,
      this.serverStateRepository,
      this.environmentSnapshotRepository,
      this.pendingChunkRepository,
      this.setupOutputRepository,
    ]);

    // Load server state from SQLite
    this.serverState = this.serverStateRepository.get();

    this.setupRunService = new SessionSetupRunService({
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      updateRunState: (setupRun) => this.updateSetupRun(setupRun),
    });
    this.turnCoordinator = new AgentTurnCoordinator({
      logger: this.logger,
      env: this.env,
      messageRepository: this.messageRepository,
      pendingChunkRepository: this.pendingChunkRepository,
      latestPlanRepository: this.latestPlanRepository,
      getServerState: () => this.serverState,
      updateServerState: (partial) => this.updateServerState(partial),
      getClientState: () => this.state,
      updatePartialState: (partial) => this.updatePartialState(partial),
      broadcastMessage: (msg: ServerMessage) => this.broadcastMessage(msg),
      synthesizeStatus: () => this.synthesizeStatus(),
      terminateActiveProcess: () => this.processManager.terminateActiveProcess(),
      updateWorkingState: (state) =>
        this.sessionSummaryService.persistWorkingState(state),
      onTurnFinished: (turn) => {
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
      },
    });
    this.syncService = new SessionSyncService({
      messageRepository: this.messageRepository,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      getPendingChunks: () => this.turnCoordinator.getPendingChunks(),
      getPendingMessageMetadata: () => this.turnCoordinator.getPendingMessageMetadata(),
    });

    this.processManager = new SpriteAgentProcessManager({
      env: this.env,
      logger: this.logger,
      secretRepository: this.secretRepository,
      getServerState: () => this.serverState,
      updateAgentProcessState: (partial) => this.updateServerState(partial),
      getClientState: () => this.state,
      getEnvironmentSnapshot: () => this.environmentSnapshotRepository.get(),
      getProviderCredentialAdapter,
    });

    this.provisionService = new SessionProvisionService({
      logger: this.logger,
      env: this.env,
      spritesCoordinator: this.spritesCoordinator,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      getEnvironmentSnapshot: () => this.environmentSnapshotRepository.get(),
      updateServerState: (partial) => this.updateServerState(partial),
      updatePartialState: (partial) => this.updatePartialState(partial),
      synthesizeStatus: () => this.synthesizeStatus(),
      ensureGitProxySecret: () => this.gitProxyService.ensureGitProxySecret(),
      githubTokenProvider: this.githubAppService,
      setupReporter: {
        startTask: (taskId) => this.setupRunService.startTask(taskId),
        completeTask: (taskId, output) => this.setupRunService.completeTask(taskId, output),
        failTask: (taskId, error, output) => this.setupRunService.failTask(taskId, error, output),
        skipTask: (taskId, skipReason) => this.setupRunService.skipTask(taskId, skipReason),
      },
      setupOutputCollector: this.setupOutputService,
    });

    this.chatDispatchService = new SessionChatDispatchService({
      logger: this.logger,
      env: this.env,
      messageRepository: this.messageRepository,
      attachmentService: this.attachmentService,
      turnCoordinator: this.turnCoordinator,
      processManager: this.processManager,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      updatePartialState: (partial) => this.updatePartialState(partial),
      broadcastMessage: (msg, without) => this.broadcastMessage(msg, without),
      sendMessageToConnection: (msg, connectionId) => {
        const connection = Array.from(this.getConnections())
          .find((candidate) => candidate.id === connectionId);
        if (!connection) {
          this.logger.warn("Cannot send message to missing connection", {
            fields: { connectionId, type: msg.type },
          });
          return;
        }
        this.sendMessage(msg, connection);
      },
      synthesizeStatus: () => this.synthesizeStatus(),
      publishSessionSummaryInvalidated: (userId, sessionId) =>
        userSessionsPublisher.invalidateSessionSummary({ userId, sessionId }),
    });

    this.providerConnectionService = new SessionProviderConnectionService({
      logger: this.logger,
      env: this.env,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      updatePartialState: (partial) => this.updatePartialState(partial),
      getProviderConnectionStatus: (provider, userId, env, logger) =>
        getProviderAuthService(provider, env, logger).getConnectionStatus(userId),
    });

    this.gitProxyService = new SessionGitProxyService({
      logger: this.logger,
      env: this.env,
      secretRepository: this.secretRepository,
      getServerState: () => this.serverState,
      getClientState: () => this.state,
      updatePartialState: (partial) => this.updatePartialState(partial),
      updatePushedBranch: (branch) =>
        this.sessionSummaryService.persistPushedBranch(branch),
      assertSessionRepoAccess: () =>
        this.repoAccessLifecycleService.assertSessionRepoAccess(),
      enforceSessionAccessBlocked: () => this.enforceSessionAccessBlocked(),
      githubTokenProvider: this.githubAppService,
    });

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
    const effectiveSetupRun = setupRun === undefined
      ? this.state.sessionSetupRun
      : setupRun;
    if (!this.serverState.initialized || !effectiveSetupRun) {
      return "preparing";
    }
    switch (effectiveSetupRun.status) {
      case "running":
        return "preparing";
      case "failed":
        return "setup_failed";
      case "completed":
        return "ready";
      default: {
        const exhaustiveCheck: never = effectiveSetupRun.status;
        throw new Error(`Unhandled setup run status: ${exhaustiveCheck}`);
      }
    }
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
    this.queueEnsureReady();
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

  /**
   * Single entry point for getting the session to a ready state.
   * Called by both handleInit (HTTP) and onConnect (WebSocket).
   * Uses mutexes so concurrent callers share one in-flight operation.
   * Each step is idempotent — skipped if already completed via serverState checkpoints.
   */
  private async ensureReady(): Promise<void> {
    if (!this.serverState.initialized) {
      const initResult = await this.initializeSessionStatePromise;
      if (!initResult) {
        this.logger.error("Session not initialized — skipping ensureReady");
        return;
      }
      if (!initResult.ok) {
        return;
      }
    }
    await this.provisionService.ensureProvisioned();
    await this.chatDispatchService.maybeDispatchPendingMessage();
  }

  private queueEnsureReady(): void {
    void this.keepAliveWhile(() => this.ensureReady()).catch((error) => {
      this.logger.error("ensureReady failed", { error });
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
        this.queueEnsureReady();
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
    // Force-kill any running vm-agent process before we tear down the sprite.
    try {
      await this.processManager.kill();
    } catch (error) {
      this.logger.warn("Failed to kill vm-agent on session delete", { error });
    }

    // Clean up sprite
    if (this.serverState.spriteName) {
      try {
        await this.spritesCoordinator.deleteSprite(this.serverState.spriteName);
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

      await this.keepAliveWhile(async () => {
        await this.ensureReady();

        if (
          this.serverState.activeUserMessageId &&
          !this.serverState.agentProcessId &&
          !this.state.pendingUserMessage
        ) {
          const staleUserMessageId = this.serverState.activeUserMessageId;
          this.logger.warn(
            "Clearing active turn with no agent process before chat dispatch",
            { fields: { userMessageId: staleUserMessageId } },
          );
          this.turnCoordinator.handleTurnSpawnFailed(
            staleUserMessageId,
            "Previous agent turn did not start",
          );
        }

        if (this.serverState.activeUserMessageId || this.state.pendingUserMessage) {
          // TODO: message queuing
          this.sendMessage(
            {
              type: "operation.error",
              code: "CHAT_MESSAGE_FAILED",
              message: "Agent is already handling a message",
            },
            connection,
          );
          return;
        }

        const result = await this.chatDispatchService.dispatchChatMessage(payload, connection.id);
        if (!result.ok) {
          this.logger.warn("Workflow chat message dispatch failed", {
            fields: { code: result.error.code },
          });
          this.sendMessage(
            {
              type: "operation.error",
              code: "CHAT_MESSAGE_FAILED",
              message: result.error.message,
            },
            connection,
          );
          return;
        }
      });
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

  private sendMessage(message: ServerMessage, to: Connection): void {
    to.send(JSON.stringify(message));
  }
}
