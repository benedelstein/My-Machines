import { SpriteLifecycleClient } from "@repo/sprites-client";
import type {
  ClientState,
  Logger,
  ServerMessage,
  SessionSetupRun,
  SessionStatus,
  SessionWorkingState,
} from "@repo/shared";
import { getProviderAuthService } from "@/modules/ai-auth/services/provider-auth.service";
import { getProviderCredentialAdapter } from
  "@/modules/ai-auth/services/provider-credential-adapter.service";
import { GitHubAppService } from "@/modules/github/services/github-app.service";
import { NotificationPublisher } from "@/modules/notifications/services/notification-publisher.service";
import { AgentSdkStateRepository } from
  "@/modules/session-agent/repositories/agent-sdk-state.repository";
import { LatestPlanRepository } from
  "@/modules/session-agent/repositories/latest-plan.repository";
import { MessageRepository } from "@/modules/session-agent/repositories/message.repository";
import { PendingChunkRepository } from
  "@/modules/session-agent/repositories/pending-chunk.repository";
import { RuntimeMigrationRepository } from
  "@/modules/session-agent/repositories/runtime-migration.repository";
import type { SqlFn } from "@/modules/session-agent/repositories/repository.types";
import { migrateAll } from "@/modules/session-agent/repositories/schema-manager.repository";
import { SecretRepository } from "@/modules/session-agent/repositories/secret.repository";
import { ServerStateRepository, type ServerState } from
  "@/modules/session-agent/repositories/server-state.repository";
import { SessionConnectorsRepository } from
  "@/modules/session-agent/repositories/session-connectors.repository";
import { SessionEnvironmentSnapshotRepository } from
  "@/modules/session-agent/repositories/session-environment-snapshot.repository";
import { SetupOutputRepository } from
  "@/modules/session-agent/repositories/setup-output.repository";
import {
  AgentTurnCoordinator,
  type FinishedAssistantTurn,
} from "@/modules/session-agent/services/agent-turn-coordinator.service";
import { SpriteAgentProcessManager } from
  "@/modules/session-agent/services/agent-process/sprite-agent-process-manager.service";
import { SessionChatDispatchService } from
  "@/modules/session-agent/services/session-chat-dispatch.service";
import { SessionConnectorService } from
  "@/modules/session-agent/services/session-connector.service";
import { SessionGitProxyService } from
  "@/modules/session-agent/services/session-git-proxy.service";
import { SessionProviderConnectionService } from
  "@/modules/session-agent/services/session-provider-connection.service";
import { RuntimeMigrationCoordinator } from
  "@/modules/session-agent/services/runtime-migration-coordinator.service";
import { RUNTIME_MIGRATIONS } from
  "@/modules/session-agent/services/runtime-migration-registry.service";
import { SessionProvisionService } from
  "@/modules/session-agent/services/session-provision.service";
import { SessionQueryService } from "@/modules/session-agent/services/session-query.service";
import { SessionSetupOutputService } from
  "@/modules/session-agent/services/session-setup-output.service";
import { SessionSetupRunService } from
  "@/modules/session-agent/services/session-setup-run.service";
import { SessionSummaryService } from
  "@/modules/session-agent/services/session-summary.service";
import { SessionSyncService } from "@/modules/session-agent/services/session-sync.service";
import { SessionsRepository } from "@/modules/sessions/repositories/sessions.repository";
import { createSessionSummaryWriter } from
  "@/modules/sessions/services/session-access.service";
import { createPullRequestForSessionContext } from
  "@/modules/sessions/services/session-pull-request.service";
import { createUserSessionsPublisher } from
  "@/modules/sessions/services/user-sessions-publisher.service";
import { createLogger } from "@/shared/logging";
import type { Env } from "@/shared/types";
import type { HandleCreatePullRequestResult } from "@/shared/types/session-agent";
import { SessionAgentAttachmentProvider } from "./session-agent-attachment-provider";
import { SessionAutoPullRequestService } from "./session-auto-pull-request.service";
import { SessionPullRequestLifecycleService } from
  "./session-pull-request-lifecycle.service";
import { SessionRepoAccessLifecycleService } from
  "./session-repo-access-lifecycle.service";
import { SessionTurnNotificationService } from "./session-turn-notification.service";

export interface SessionAgentRepositories {
  messageRepository: MessageRepository;
  secretRepository: SecretRepository;
  latestPlanRepository: LatestPlanRepository;
  serverStateRepository: ServerStateRepository;
  environmentSnapshotRepository: SessionEnvironmentSnapshotRepository;
  pendingChunkRepository: PendingChunkRepository;
  runtimeMigrationRepository: RuntimeMigrationRepository;
  setupOutputRepository: SetupOutputRepository;
}

export interface SessionAgentDependencies {
  spriteLifecycleClient: SpriteLifecycleClient;
  attachmentService: SessionAgentAttachmentProvider;
  turnCoordinator: AgentTurnCoordinator;
  processManager: SpriteAgentProcessManager;
  runtimeMigrationCoordinator: RuntimeMigrationCoordinator;
  provisionService: SessionProvisionService;
  chatDispatchService: SessionChatDispatchService;
  setupRunService: SessionSetupRunService;
  providerConnectionService: SessionProviderConnectionService;
  sessionConnectorService: SessionConnectorService;
  gitProxyService: SessionGitProxyService;
  queryService: SessionQueryService;
  sessionSummaryService: SessionSummaryService;
  syncService: SessionSyncService;
  pullRequestLifecycleService: SessionPullRequestLifecycleService;
  repoAccessLifecycleService: SessionRepoAccessLifecycleService;
  autoPullRequestService: SessionAutoPullRequestService;
  turnNotificationService: SessionTurnNotificationService;
}

export interface SessionAgentDependencyHost {
  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updateServerState: (partial: Partial<ServerState>) => void;
  updatePartialState: (partial: Partial<ClientState>) => void;
  updateSetupRun: (setupRun: SessionSetupRun) => void;
  broadcastMessage: (message: ServerMessage, without?: string[]) => void;
  sendMessageToConnection: (message: ServerMessage, connectionId: string) => void;
  synthesizeStatus: () => SessionStatus;
  cancelActiveTurnAndClearState: () => Promise<void>;
  keepAliveWhile: (callback: () => Promise<void>) => Promise<void>;
  createPullRequest: () => Promise<HandleCreatePullRequestResult>;
  enforceSessionAccessBlocked: (notifyClients?: boolean) => Promise<void>;
  updateWorkingState: (state: SessionWorkingState) => void;
  persistPushedBranch: (branch: string) => void;
  onTurnFinished: (turn: FinishedAssistantTurn) => void;
  onTurnSettled: () => void;
}

export function createSessionAgentRepositories(
  sql: SqlFn,
  storage: DurableObjectStorage,
): SessionAgentRepositories {
  const messageRepository = new MessageRepository(sql);
  const secretRepository = new SecretRepository(sql);
  const latestPlanRepository = new LatestPlanRepository(sql);
  const serverStateRepository = new ServerStateRepository(sql);
  const environmentSnapshotRepository = new SessionEnvironmentSnapshotRepository(sql);
  const pendingChunkRepository = new PendingChunkRepository(sql);
  const runtimeMigrationRepository = new RuntimeMigrationRepository(sql);
  const setupOutputRepository = new SetupOutputRepository(sql);

  migrateAll(sql, storage, [
    messageRepository,
    secretRepository,
    latestPlanRepository,
    serverStateRepository,
    environmentSnapshotRepository,
    pendingChunkRepository,
    runtimeMigrationRepository,
    setupOutputRepository,
    // Migration-only Agents SDK client-state adapter; normal reads/writes stay on the SDK.
    new AgentSdkStateRepository(),
  ]);

  return {
    messageRepository,
    secretRepository,
    latestPlanRepository,
    serverStateRepository,
    environmentSnapshotRepository,
    pendingChunkRepository,
    runtimeMigrationRepository,
    setupOutputRepository,
  };
}

export function createSessionAgentDependencies(input: {
  env: Env;
  logger: Logger;
  repositories: SessionAgentRepositories;
  host: SessionAgentDependencyHost;
}): SessionAgentDependencies {
  const { env, logger, repositories, host } = input;
  const {
    messageRepository,
    secretRepository,
    latestPlanRepository,
    environmentSnapshotRepository,
    pendingChunkRepository,
    runtimeMigrationRepository,
    setupOutputRepository,
  } = repositories;

  const setupOutputService = new SessionSetupOutputService({
    logger,
    repository: setupOutputRepository,
    broadcastMessage: host.broadcastMessage,
  });
  const runtimeMigrationCoordinator = new RuntimeMigrationCoordinator({
    repository: runtimeMigrationRepository,
    definitions: RUNTIME_MIGRATIONS,
    logger: logger.scope("runtime-migration-coordinator"),
  });
  const spriteLifecycleClient = new SpriteLifecycleClient({
    apiKey: env.SPRITES_API_KEY,
    logger: createLogger("sprites.ts"),
  });
  const attachmentService = new SessionAgentAttachmentProvider(env.DB);
  const githubAppService = new GitHubAppService(env, logger);
  const notificationPublisher = new NotificationPublisher(env);
  const turnNotificationService = new SessionTurnNotificationService({
    notificationPublisher,
    sessionsRepository: new SessionsRepository(env.DB),
  });
  const userSessionsPublisher = createUserSessionsPublisher(
    env,
    logger.scope("user-sessions-publisher"),
  );
  const sessionSummaryService = new SessionSummaryService({
    repository: createSessionSummaryWriter(env),
    getSessionId: () => host.getServerState().sessionId,
    getUserId: () => host.getServerState().userId,
    publishSessionSummaryInvalidated: (userId, sessionId) =>
      userSessionsPublisher.invalidateSessionSummary({ userId, sessionId }),
    logger,
  });
  const queryService = new SessionQueryService({
    messageRepository,
    latestPlanRepository,
    setupOutputRepository,
    getSetupOutputEpoch: () => setupOutputService.getEpoch(),
    getServerState: host.getServerState,
    getClientState: host.getClientState,
  });
  const pullRequestLifecycleService = new SessionPullRequestLifecycleService({
    logger,
    github: githubAppService,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    webOrigin: env.WEB_ORIGIN,
    createPullRequest: createPullRequestForSessionContext,
    messageRepository,
    sessionSummaryService,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    setPullRequestClientState: (pullRequest) => host.updatePartialState({ pullRequest }),
  });

  // Service constructors only retain these callbacks. Some callbacks reference
  // services declared later and must not run until the complete graph is returned.
  const repoAccessLifecycleService = new SessionRepoAccessLifecycleService({
    logger,
    env,
    getServerState: host.getServerState,
    updatePartialState: host.updatePartialState,
    cancelActiveTurnAndClearState: host.cancelActiveTurnAndClearState,
    killActiveProcess: () => processManager.kill(),
  });
  const autoPullRequestService = new SessionAutoPullRequestService({
    logger,
    createPullRequest: host.createPullRequest,
    getState: () => ({
      sessionId: host.getServerState().sessionId,
      repoFullName: host.getClientState().repoFullName,
      pushedBranch: host.getClientState().pushedBranch,
      pullRequestStatus: host.getClientState().pullRequest?.status ?? null,
    }),
    keepAliveWhile: host.keepAliveWhile,
    assertSessionRepoAccess: () => repoAccessLifecycleService.assertSessionRepoAccess(),
    enforceSessionAccessBlocked: () => host.enforceSessionAccessBlocked(false),
  });
  const setupRunService = new SessionSetupRunService({
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    updateRunState: host.updateSetupRun,
  });
  const turnCoordinator = new AgentTurnCoordinator({
    logger,
    env,
    messageRepository,
    pendingChunkRepository,
    latestPlanRepository,
    getServerState: host.getServerState,
    updateServerState: host.updateServerState,
    getClientState: host.getClientState,
    updatePartialState: host.updatePartialState,
    broadcastMessage: host.broadcastMessage,
    synthesizeStatus: host.synthesizeStatus,
    terminateActiveProcess: () => processManager.terminateActiveProcess(),
    updateWorkingState: host.updateWorkingState,
    onTurnFinished: host.onTurnFinished,
    onTurnSettled: host.onTurnSettled,
  });
  const syncService = new SessionSyncService({
    messageRepository,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    getPendingChunks: () => turnCoordinator.getPendingChunks(),
    getPendingMessageMetadata: () => turnCoordinator.getPendingMessageMetadata(),
  });

  const processManager: SpriteAgentProcessManager = new SpriteAgentProcessManager({
    env,
    logger,
    secretRepository,
    getServerState: host.getServerState,
    updateAgentProcessState: host.updateServerState,
    getClientState: host.getClientState,
    getEnvironmentSnapshot: () => environmentSnapshotRepository.get(),
    getProviderCredentialAdapter,
    getConnectorGatewayBase: () => sessionConnectorService.getGatewayBase(),
  });
  const sessionConnectorService: SessionConnectorService = new SessionConnectorService({
    logger,
    env,
    spriteLifecycleClient,
    repository: new SessionConnectorsRepository(env.DB),
    getServerState: host.getServerState,
    setSessionConnectorId: (gatewayConnectionId) =>
      host.updateServerState({ sessionConnectorId: gatewayConnectionId }),
    getEnvironmentSnapshot: () => environmentSnapshotRepository.get(),
    ensureWebhookToken: () => processManager.ensureWebhookToken(),
  });
  const provisionService = new SessionProvisionService({
    logger,
    env,
    spriteLifecycleClient,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    getEnvironmentSnapshot: () => environmentSnapshotRepository.get(),
    updateServerState: host.updateServerState,
    updatePartialState: host.updatePartialState,
    synthesizeStatus: host.synthesizeStatus,
    retireGitProxySecret: () => gitProxyService.retireGitProxySecret(),
    ensureSessionConnector: (spriteName) => sessionConnectorService.ensureMinted(spriteName),
    getSessionConnectorGatewayBase: () => sessionConnectorService.getGatewayBase(),
    githubTokenProvider: githubAppService,
    setupReporter: {
      startTask: (taskId) => setupRunService.startTask(taskId),
      completeTask: (taskId, output) => setupRunService.completeTask(taskId, output),
      failTask: (taskId, error, output) => setupRunService.failTask(taskId, error, output),
      skipTask: (taskId, skipReason) => setupRunService.skipTask(taskId, skipReason),
    },
    setupOutputCollector: setupOutputService,
  });
  const chatDispatchService = new SessionChatDispatchService({
    logger,
    env,
    messageRepository,
    attachmentService,
    turnCoordinator,
    processManager,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    updatePartialState: host.updatePartialState,
    broadcastMessage: host.broadcastMessage,
    sendMessageToConnection: host.sendMessageToConnection,
    synthesizeStatus: host.synthesizeStatus,
    publishSessionSummaryInvalidated: (userId, sessionId) =>
      userSessionsPublisher.invalidateSessionSummary({ userId, sessionId }),
  });
  const providerConnectionService = new SessionProviderConnectionService({
    logger,
    env,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    updatePartialState: host.updatePartialState,
    getProviderConnectionStatus: (provider, userId, providerEnv, providerLogger) =>
      getProviderAuthService(provider, providerEnv, providerLogger)
        .getConnectionStatus(userId),
  });
  const gitProxyService = new SessionGitProxyService({
    logger,
    env,
    secretRepository,
    getServerState: host.getServerState,
    getClientState: host.getClientState,
    updatePartialState: host.updatePartialState,
    updatePushedBranch: host.persistPushedBranch,
    assertSessionRepoAccess: () => repoAccessLifecycleService.assertSessionRepoAccess(),
    enforceSessionAccessBlocked: host.enforceSessionAccessBlocked,
    githubTokenProvider: githubAppService,
  });

  return {
    spriteLifecycleClient,
    attachmentService,
    turnCoordinator,
    processManager,
    runtimeMigrationCoordinator,
    provisionService,
    chatDispatchService,
    setupRunService,
    providerConnectionService,
    sessionConnectorService,
    gitProxyService,
    queryService,
    sessionSummaryService,
    syncService,
    pullRequestLifecycleService,
    repoAccessLifecycleService,
    autoPullRequestService,
    turnNotificationService,
  };
}
