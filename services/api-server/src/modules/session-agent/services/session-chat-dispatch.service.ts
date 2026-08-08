import {
  type AgentMode,
  type AgentSettings,
  type ChatMessageEvent,
  type ClientState,
  type DomainError,
  type Logger,
  type ServerMessage,
  type SessionStatus,
  type Result,
  failure,
  getProviderEffortDefinition,
  getProviderModelDefinition,
  success,
  aiMessageFromWire,
} from "@repo/shared";
import type { Env } from "@/shared/types";
import type { UIMessage } from "ai";
import type { AttachmentRecord } from "@/shared/types/attachments";
import { createUserUiMessage, getUserMessageTextContent } from "@/shared/utils/uimessage-utils";
import { updateSessionHistoryData } from "./session-agent-history.service";
import type { MessageRepository } from "../repositories/message.repository";
import type { ServerState } from
  "../types/server-state.types";
import type { AgentTurnCoordinator } from "./agent-turn-coordinator.service";
import type { SpriteAgentProcessManager } from "./agent-process/sprite-agent-process-manager.service";
import type { SpriteAgentProcessManagerError } from "../types/agent-process-manager.types";

const CHAT_DISPATCH_DOMAIN = "chat_dispatch";

export type ChatDispatchError =
  | DomainError<
      typeof CHAT_DISPATCH_DOMAIN,
      | "SESSION_NOT_INITIALIZED"
      | "INVALID_MESSAGE"
      | "INVALID_MODEL"
      | "INVALID_EFFORT"
      | "DISPATCH_FAILED",
      object
    >
  | SpriteAgentProcessManagerError;

function chatDispatchError<
  Code extends Extract<ChatDispatchError, { domain: typeof CHAT_DISPATCH_DOMAIN }>["code"],
>(
  code: Code,
  message: string,
  details: object = {},
): Extract<ChatDispatchError, { code: Code }> {
  return {
    domain: CHAT_DISPATCH_DOMAIN,
    code,
    message,
    ...details,
  } as Extract<ChatDispatchError, { code: Code }>;
}

/**
 * Dependencies injected from the SessionAgentDO into the chat dispatch service.
 */
export interface SessionChatDispatchServiceDeps {
  logger: Logger;
  env: Env;
  messageRepository: MessageRepository;
  attachmentService: SessionChatAttachmentProvider;
  turnCoordinator: AgentTurnCoordinator;
  processManager: SpriteAgentProcessManager;

  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updatePartialState: (partial: Partial<ClientState>) => void;
  broadcastMessage: (message: ServerMessage, without?: string[]) => void;
  sendMessageToConnection: (message: ServerMessage, connectionId: string) => void;
  synthesizeStatus: () => SessionStatus;
  publishSessionSummaryInvalidated: (
    userId: string,
    sessionId: string,
  ) => Promise<void>;
}

export interface SessionChatAttachmentProvider {
  getByIdsBoundToSession(
    sessionId: string,
    attachmentIds: string[],
  ): Promise<AttachmentRecord[]>;
}

export interface PreparedChatMessage {
  userMessage: UIMessage;
  content: string | undefined;
  attachmentIds: string[];
  connectionId: string;
  clientMessageId: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  agentMode: AgentMode | undefined;
}

export interface ClaimedTurn {
  userMessageId: string;
  content: string | undefined;
  attachmentIds: string[];
  model?: string;
  effort?: string;
  agentMode?: AgentMode;
}

/**
 * Owns dispatching user chat turns into the vm-agent process.
 * Validates the payload, persists the user message, delegates to
 * SpriteAgentProcessManager to spawn the process, and registers the turn
 * with the coordinator so inbound webhooks can correlate.
 */
export class SessionChatDispatchService {
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly messageRepository: MessageRepository;
  private readonly attachmentService: SessionChatAttachmentProvider;
  private readonly turnCoordinator: AgentTurnCoordinator;
  private readonly processManager: SpriteAgentProcessManager;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly updatePartialState: SessionChatDispatchServiceDeps["updatePartialState"];
  private readonly broadcastMessage: SessionChatDispatchServiceDeps["broadcastMessage"];
  private readonly sendMessageToConnection: SessionChatDispatchServiceDeps["sendMessageToConnection"];
  private readonly synthesizeStatus: () => SessionStatus;
  private readonly publishSessionSummaryInvalidated:
    SessionChatDispatchServiceDeps["publishSessionSummaryInvalidated"];
  private readonly dispatchingTurnIds = new Set<string>();

  constructor(deps: SessionChatDispatchServiceDeps) {
    this.logger = deps.logger.scope("session-chat-dispatch");
    this.env = deps.env;
    this.messageRepository = deps.messageRepository;
    this.attachmentService = deps.attachmentService;
    this.turnCoordinator = deps.turnCoordinator;
    this.processManager = deps.processManager;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.updatePartialState = deps.updatePartialState;
    this.broadcastMessage = deps.broadcastMessage;
    this.sendMessageToConnection = deps.sendMessageToConnection;
    this.synthesizeStatus = deps.synthesizeStatus;
    this.publishSessionSummaryInvalidated = deps.publishSessionSummaryInvalidated;
  }

  /** Resolves and validates a chat message without mutating session state. */
  async prepareChatMessage(
    payload: ChatMessageEvent,
    connectionId: string,
  ): Promise<Result<PreparedChatMessage, ChatDispatchError>> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    if (!sessionId) {
      return failure(
        chatDispatchError("SESSION_NOT_INITIALIZED", "Session is not initialized"),
      );
    }

    const attachmentIds =
      payload.attachments?.map((attachment) => attachment.attachmentId) ?? [];
    const attachmentRecords = await this.getBoundAttachmentRecords(
      sessionId,
      attachmentIds,
    );

    const content = payload.content?.trim();

    const clientState = this.getClientState();
    let modelOverride: string | undefined;
    if (payload.model && payload.model !== clientState.agentSettings.model) {
      const modelResult = this.validateModelSwitch(payload.model);
      if (!modelResult.ok) { return failure(modelResult.error); }
      modelOverride = modelResult.value;
    }

    let effortOverride: string | undefined;
    if (payload.effort && payload.effort !== clientState.agentSettings.effort) {
      const effortResult = this.validateEffortSwitch(payload.effort);
      if (!effortResult.ok) { return failure(effortResult.error); }
      effortOverride = effortResult.value;
    }

    const agentModeOverride = payload.agentMode !== clientState.agentMode
      ? payload.agentMode
      : undefined;

    const userUiMessage = createUserUiMessage(
      content,
      attachmentRecords,
    );
    if (!userUiMessage) {
      return failure(
        chatDispatchError(
          "INVALID_MESSAGE",
          "Message must include content or attachments",
        ),
      );
    }

    return success({
      userMessage: userUiMessage,
      content,
      attachmentIds,
      connectionId,
      clientMessageId: payload.clientMessageId,
      model: modelOverride,
      effort: effortOverride,
      agentMode: agentModeOverride,
    });
  }

  /** Persists a prepared message and synchronously marks its turn claimed. */
  claimPreparedMessage(prepared: PreparedChatMessage): ClaimedTurn {
    const clientState = this.getClientState();
    if (prepared.model || prepared.effort) {
      this.updatePartialState({
        agentSettings: {
          ...clientState.agentSettings,
          model: prepared.model ?? clientState.agentSettings.model,
          effort: prepared.effort ?? clientState.agentSettings.effort,
        } as AgentSettings,
      });
    }
    if (prepared.agentMode) {
      this.updatePartialState({ agentMode: prepared.agentMode });
    }

    this.onUserMessageSent(
      prepared.userMessage,
      prepared.attachmentIds,
      prepared.connectionId,
      prepared.clientMessageId,
    );
    return this.claimTurn({
      userMessageId: prepared.userMessage.id,
      content: prepared.content,
      attachmentIds: prepared.attachmentIds,
      model: prepared.model,
      effort: prepared.effort,
      agentMode: prepared.agentMode,
    });
  }

  /** Claims the pending initial message without starting process I/O. */
  claimPendingMessage(): ClaimedTurn | null {
    const clientState = this.getClientState();
    const serverState = this.getServerState();
    const pendingMessage = clientState.pendingUserMessage;
    if (!pendingMessage || serverState.activeUserMessageId || !serverState.sessionId) {
      return null;
    }

    this.logger.debug("Claiming pending message", {
      fields: { messageId: pendingMessage.message.id },
    });
    const { attachmentIds } = pendingMessage;
    const userMessage = aiMessageFromWire(pendingMessage.message);
    const content = getUserMessageTextContent(userMessage);

    this.updatePartialState({ pendingUserMessage: null });
    this.onUserMessageSent(userMessage, attachmentIds);
    return this.claimTurn({
      userMessageId: userMessage.id,
      content,
      attachmentIds,
    });
  }

  /** Dispatches an already-claimed turn and clears it through the failure path. */
  async spawnClaimedTurn(
    claimedTurn: ClaimedTurn,
  ): Promise<Result<void, ChatDispatchError>> {
    try {
      const dispatchResult = await this.spawnTurn(claimedTurn);
      if (!dispatchResult.ok) {
        this.turnCoordinator.handleTurnSpawnFailed(
          claimedTurn.userMessageId,
          dispatchResult.error.message,
        );
      }
      return dispatchResult;
    } finally {
      this.dispatchingTurnIds.delete(claimedTurn.userMessageId);
    }
  }

  /** Clears a durable claim left behind before dispatch was confirmed. */
  recoverInterruptedClaim(): string | null {
    const serverState = this.getServerState();
    const userMessageId = serverState.activeUserMessageId;
    if (
      !userMessageId ||
      serverState.activeTurnDispatchStatus !== "claimed" ||
      this.dispatchingTurnIds.has(userMessageId)
    ) {
      return null;
    }

    this.logger.warn("Recovering interrupted claimed turn", {
      fields: { userMessageId },
    });
    this.turnCoordinator.handleTurnSpawnFailed(
      userMessageId,
      "Previous agent turn did not start",
    );
    return userMessageId;
  }

  private claimTurn(claimedTurn: ClaimedTurn): ClaimedTurn {
    this.dispatchingTurnIds.add(claimedTurn.userMessageId);
    this.turnCoordinator.beginTurn(claimedTurn.userMessageId);
    return claimedTurn;
  }

  private async spawnTurn(args: ClaimedTurn): Promise<Result<void, ChatDispatchError>> {
    let spawnResult;
    try {
      spawnResult = await this.processManager.dispatchMessage({
        userMessage: {
          id: args.userMessageId,
          content: args.content,
          attachmentIds: args.attachmentIds,
        },
        model: args.model,
        effort: args.effort,
        agentMode: args.agentMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        chatDispatchError("DISPATCH_FAILED", message, { cause: message }),
      );
    }
    if (!spawnResult.ok) {
      return failure(spawnResult.error);
    }

    this.turnCoordinator.markTurnDispatched(
      args.userMessageId,
      spawnResult.value.agentProcessId,
    );
    return success(undefined);
  }

  private validateModelSwitch(
    model: string,
  ): Result<string, ChatDispatchError> {
    const clientState = this.getClientState();
    const validatedModel = getProviderModelDefinition(
      clientState.agentSettings.provider,
      model,
    );
    if (!validatedModel) {
      this.logger.warn("Invalid provider model in chat dispatch", {
        fields: { provider: clientState.agentSettings.provider, model },
      });
      return failure(
        chatDispatchError("INVALID_MODEL", "Invalid model for the current provider", {
          provider: clientState.agentSettings.provider,
          model,
        }),
      );
    }

    return success(validatedModel.id);
  }

  private validateEffortSwitch(
    effort: string,
  ): Result<string, ChatDispatchError> {
    const clientState = this.getClientState();
    const validatedEffort = getProviderEffortDefinition(
      clientState.agentSettings.provider,
      effort,
    );
    if (!validatedEffort) {
      this.logger.warn("Invalid provider effort in chat dispatch", {
        fields: { provider: clientState.agentSettings.provider, effort },
      });
      return failure(
        chatDispatchError("INVALID_EFFORT", "Invalid effort for the current provider", {
          provider: clientState.agentSettings.provider,
          effort,
        }),
      );
    }

    return success(validatedEffort.id);
  }

  private async getBoundAttachmentRecords(
    sessionId: string,
    attachmentIds: string[],
  ): Promise<AttachmentRecord[]> {
    if (attachmentIds.length === 0) { return []; }
    return this.attachmentService.getByIdsBoundToSession(sessionId, attachmentIds);
  }

  private onUserMessageSent(
    message: UIMessage,
    attachmentIds: string[],
    connectionId?: string,
    clientMessageId?: string,
  ): void {
    const sessionId = this.getServerState().sessionId;
    if (!sessionId) { return; }
    const existing = this.messageRepository.getById(message.id);
    if (existing) { return; }
    const stored = this.messageRepository.create(sessionId, message);
    if (connectionId && clientMessageId) {
      this.sendMessageToConnection(
        {
          type: "chat.accepted",
          clientMessageId,
          messageId: stored.message.id,
        },
        connectionId,
      );
    }
    this.broadcastMessage(
      { type: "user.message", message: stored.message },
      connectionId ? [connectionId] : undefined,
    );

    void this.handleSentMessageSideEffects(sessionId, message, attachmentIds)
      .catch((error) => {
        this.logger.warn("User message side effects failed", { error });
      });
  }

  private async handleSentMessageSideEffects(
    sessionId: string,
    message: UIMessage,
    attachmentIds: string[],
  ): Promise<void> {
    const content = getUserMessageTextContent(message);
    const attachmentRecords = await this.getBoundAttachmentRecords(
      sessionId,
      attachmentIds,
    );
    const historyContent = this.toHistorySyncContent(content, attachmentRecords);
    const historyUpdateResult = await updateSessionHistoryData({
      database: this.env.DB,
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      logger: this.logger,
      sessionId,
      messageContent: historyContent,
      messageRepository: this.messageRepository,
    });
    if (!historyUpdateResult.updatedSessionSummary) {
      return;
    }

    const { userId } = this.getServerState();
    if (!userId) {
      return;
    }

    try {
      await this.publishSessionSummaryInvalidated(userId, sessionId);
    } catch (error) {
      this.logger.warn("Failed to publish session summary invalidation", {
        error,
        fields: { sessionId, userId },
      });
    }
  }

  private toHistorySyncContent(
    content: string | undefined,
    attachments: AttachmentRecord[],
  ): string {
    if (content) { return content; }
    if (attachments.length === 1) {
      return `Uploaded image: ${attachments[0]!.filename}`;
    }
    return `Uploaded ${attachments.length} images`;
  }
}
