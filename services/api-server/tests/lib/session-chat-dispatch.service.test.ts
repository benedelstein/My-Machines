import {
  DEFAULT_AGENT_SETTINGS,
  type ChatMessageEvent,
  type ClientState,
  type Logger,
  type ServerMessage,
  type SessionStatus,
  success,
} from "@repo/shared";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/shared/types";
import type {
  StoredMessage,
  MessageRepository,
} from "../../src/modules/session-agent/repositories/message.repository";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import type { AgentTurnCoordinator } from "../../src/modules/session-agent/services/agent-turn-coordinator.service";
import type { SpriteAgentProcessManager } from "../../src/modules/session-agent/services/agent-process/sprite-agent-process-manager.service";
import {
  SessionChatDispatchService,
  type SessionChatAttachmentProvider,
} from "../../src/modules/session-agent/services/session-chat-dispatch.service";

const historyMockState = vi.hoisted(() => ({
  updateSessionHistoryData: vi.fn(),
}));

vi.mock("../../src/modules/session-agent/services/session-agent-history.service", () => ({
  updateSessionHistoryData: historyMockState.updateSessionHistoryData,
}));

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174010";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const CLIENT_MESSAGE_ID = "123e4567-e89b-12d3-a456-426614174099";
const SERVER_MESSAGE_ID = "123e4567-e89b-12d3-a456-426614174098" as
  `${string}-${string}-${string}-${string}-${string}`;

const noopLogger: Logger = {
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  scope: () => noopLogger,
};

function makeServerState(): ServerState {
  return {
    initialized: true,
    sessionId: SESSION_ID,
    userId: USER_ID,
    spriteName: "sprite-test",
    repoCloned: true,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    activeTurnDispatchStatus: null,
    startupToolchain: null,
    startupScriptCompleted: true,
    finalNetworkPolicyApplied: true,
    sessionConnectorId: null,
    spriteLabelsApplied: true,
    gitAuthMode: "ephemeral_token",
  };
}

function makeClientState(): ClientState {
  return {
    repoFullName: "owner/repo",
    status: "ready",
    sessionSetupRun: null,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    pullRequest: null,
    pushedBranch: null,
    baseBranch: null,
    todos: null,
    plan: null,
    pendingUserMessage: null,
    activeTurn: null,
    editorUrl: null,
    providerConnection: null,
    agentMode: "edit",
    lastError: null,
    createdAt: new Date("2026-05-24T10:00:00.000Z"),
  };
}

function makeMessageRepository(): MessageRepository {
  const repository = {
    getById: vi.fn((_id: string): StoredMessage | null => null),
    create: vi.fn((sessionId: string, message: UIMessage): StoredMessage => ({
      sessionId,
      createdAt: "2026-05-24T10:00:01.000Z",
      message,
    })),
    getAllBySession: vi.fn((_sessionId: string): StoredMessage[] => []),
  };
  return repository as unknown as MessageRepository;
}

function makeChatDispatchHarness(params: {
  publishSessionSummaryInvalidated: (userId: string, sessionId: string) => Promise<void>;
  serverState?: ServerState;
  clientState?: ClientState;
}) {
  const serverState = params.serverState ?? makeServerState();
  const clientState = params.clientState ?? makeClientState();
  const turnCoordinator = {
    beginTurn: vi.fn(),
    markTurnDispatched: vi.fn(),
    handleTurnSpawnFailed: vi.fn(),
  } as unknown as AgentTurnCoordinator;
  const processManager = {
    dispatchMessage: vi.fn(async () => success({ agentProcessId: 42 })),
  } as unknown as SpriteAgentProcessManager;
  const attachmentService: SessionChatAttachmentProvider = {
    getByIdsBoundToSession: vi.fn(async () => []),
  };
  const messageRepository = makeMessageRepository();
  const broadcastMessage = vi.fn((_message: ServerMessage, _without?: string[]) => {});
  const sendMessageToConnection = vi.fn((_message: ServerMessage, _connectionId: string) => {});
  const updatePartialState = vi.fn((partial: Partial<ClientState>) => {
    Object.assign(clientState, partial);
  });

  const service = new SessionChatDispatchService({
    logger: noopLogger,
    env: {
      DB: {} as D1Database,
      ANTHROPIC_API_KEY: "test-api-key",
    } as unknown as Env,
    messageRepository,
    attachmentService,
    turnCoordinator,
    processManager,
    getServerState: () => serverState,
    getClientState: () => clientState,
    updatePartialState,
    broadcastMessage,
    sendMessageToConnection,
    synthesizeStatus: vi.fn((): SessionStatus => "ready"),
    publishSessionSummaryInvalidated: params.publishSessionSummaryInvalidated,
  });

  return {
    service,
    messageRepository,
    broadcastMessage,
    sendMessageToConnection,
    turnCoordinator,
    processManager,
    updatePartialState,
    serverState,
    clientState,
  };
}

function makeChatDispatchService(params: {
  publishSessionSummaryInvalidated: (userId: string, sessionId: string) => Promise<void>;
}): SessionChatDispatchService {
  return makeChatDispatchHarness(params).service;
}

function makeChatMessage(): ChatMessageEvent {
  return {
    type: "chat.message",
    content: "Update sidebar title",
    clientMessageId: CLIENT_MESSAGE_ID,
  };
}

describe("SessionChatDispatchService", () => {
  beforeEach(() => {
    historyMockState.updateSessionHistoryData.mockReset();
    vi.restoreAllMocks();
  });

  it("stores, broadcasts, and dispatches the server-generated user message id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(SERVER_MESSAGE_ID);
    const harness = makeChatDispatchHarness({
      publishSessionSummaryInvalidated: vi.fn(async () => {}),
    });

    const prepared = await harness.service.prepareChatMessage(makeChatMessage(), "connection-1");

    expect(prepared.ok).toBe(true);
    expect(harness.messageRepository.create).not.toHaveBeenCalled();
    expect(harness.turnCoordinator.beginTurn).not.toHaveBeenCalled();
    if (!prepared.ok) { return; }
    const claimedTurn = harness.service.claimPreparedMessage(prepared.value);

    expect(harness.turnCoordinator.beginTurn).toHaveBeenCalledWith(SERVER_MESSAGE_ID);
    expect(harness.processManager.dispatchMessage).not.toHaveBeenCalled();

    const result = await harness.service.spawnClaimedTurn(claimedTurn);

    expect(result).toEqual(success(undefined));
    expect(harness.messageRepository.create).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ id: SERVER_MESSAGE_ID }),
    );
    expect(harness.messageRepository.create).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ id: CLIENT_MESSAGE_ID }),
    );
    expect(harness.sendMessageToConnection).toHaveBeenCalledWith(
      {
        type: "chat.accepted",
        clientMessageId: CLIENT_MESSAGE_ID,
        messageId: SERVER_MESSAGE_ID,
      },
      "connection-1",
    );
    expect(harness.broadcastMessage).toHaveBeenCalledWith(
      {
        type: "user.message",
        message: expect.objectContaining({ id: SERVER_MESSAGE_ID }),
      },
      ["connection-1"],
    );
    expect(harness.turnCoordinator.markTurnDispatched).toHaveBeenCalledWith(
      SERVER_MESSAGE_ID,
      42,
    );
    expect(harness.processManager.dispatchMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({ id: SERVER_MESSAGE_ID }),
      }),
    );
    expect(harness.messageRepository.create.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sendMessageToConnection.mock.invocationCallOrder[0]!,
    );
    expect(harness.sendMessageToConnection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.broadcastMessage.mock.invocationCallOrder[0]!,
    );
    expect(harness.broadcastMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.turnCoordinator.beginTurn.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps preparation mutation-free and applies overrides only while claiming", async () => {
    const harness = makeChatDispatchHarness({
      publishSessionSummaryInvalidated: vi.fn(async () => {}),
    });

    const prepared = await harness.service.prepareChatMessage(
      { ...makeChatMessage(), agentMode: "plan" },
      "connection-1",
    );

    expect(prepared.ok).toBe(true);
    expect(harness.updatePartialState).not.toHaveBeenCalled();
    expect(harness.messageRepository.create).not.toHaveBeenCalled();
    expect(harness.broadcastMessage).not.toHaveBeenCalled();
    expect(harness.turnCoordinator.beginTurn).not.toHaveBeenCalled();
    if (!prepared.ok) { return; }

    harness.service.claimPreparedMessage(prepared.value);

    expect(harness.updatePartialState).toHaveBeenCalledWith({ agentMode: "plan" });
    expect(harness.messageRepository.create).toHaveBeenCalledOnce();
    expect(harness.turnCoordinator.beginTurn).toHaveBeenCalledOnce();
  });

  it("claims a pending initial message before starting process I/O", () => {
    const pendingMessage = {
      message: {
        id: SERVER_MESSAGE_ID,
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Initial request" }],
      },
      attachmentIds: [],
    };
    const harness = makeChatDispatchHarness({
      publishSessionSummaryInvalidated: vi.fn(async () => {}),
      clientState: { ...makeClientState(), pendingUserMessage: pendingMessage },
    });

    const claimedTurn = harness.service.claimPendingMessage();

    expect(claimedTurn).toEqual(expect.objectContaining({
      userMessageId: SERVER_MESSAGE_ID,
      content: "Initial request",
    }));
    expect(harness.updatePartialState).toHaveBeenCalledWith({ pendingUserMessage: null });
    expect(harness.turnCoordinator.beginTurn).toHaveBeenCalledWith(SERVER_MESSAGE_ID);
    expect(harness.processManager.dispatchMessage).not.toHaveBeenCalled();
  });

  it("recovers a durable claim only when this instance is not dispatching it", async () => {
    const interruptedHarness = makeChatDispatchHarness({
      publishSessionSummaryInvalidated: vi.fn(async () => {}),
      serverState: {
        ...makeServerState(),
        activeUserMessageId: SERVER_MESSAGE_ID,
        activeTurnDispatchStatus: "claimed",
      },
    });

    expect(interruptedHarness.service.recoverInterruptedClaim()).toBe(SERVER_MESSAGE_ID);
    expect(interruptedHarness.turnCoordinator.handleTurnSpawnFailed).toHaveBeenCalledWith(
      SERVER_MESSAGE_ID,
      "Previous agent turn did not start",
    );

    const liveHarness = makeChatDispatchHarness({
      publishSessionSummaryInvalidated: vi.fn(async () => {}),
    });
    const prepared = await liveHarness.service.prepareChatMessage(
      makeChatMessage(),
      "connection-1",
    );
    if (!prepared.ok) { throw new Error(prepared.error.message); }
    liveHarness.service.claimPreparedMessage(prepared.value);

    expect(liveHarness.service.recoverInterruptedClaim()).toBeNull();
    expect(liveHarness.turnCoordinator.handleTurnSpawnFailed).not.toHaveBeenCalled();
  });

  it("publishes a summary invalidation only after history persistence resolves", async () => {
    const operations: string[] = [];
    const historyDeferred = Promise.withResolvers<{ updatedSessionSummary: boolean }>();
    const publishDeferred = Promise.withResolvers<void>();
    historyMockState.updateSessionHistoryData.mockImplementation(async () => {
      operations.push("history:start");
      const result = await historyDeferred.promise;
      operations.push("history:done");
      return result;
    });
    const publishSessionSummaryInvalidated = vi.fn(async () => {
      operations.push("publish");
      publishDeferred.resolve();
    });
    const service = makeChatDispatchService({ publishSessionSummaryInvalidated });

    const prepared = await service.prepareChatMessage(makeChatMessage(), "connection-1");
    if (!prepared.ok) { throw new Error(prepared.error.message); }
    const claimedTurn = service.claimPreparedMessage(prepared.value);
    await service.spawnClaimedTurn(claimedTurn);
    await Promise.resolve();

    expect(operations).toEqual(["history:start"]);
    expect(publishSessionSummaryInvalidated).not.toHaveBeenCalled();

    historyDeferred.resolve({ updatedSessionSummary: true });
    await publishDeferred.promise;

    expect(operations).toEqual(["history:start", "history:done", "publish"]);
    expect(publishSessionSummaryInvalidated).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
    );
  });

  it("does not publish when history persistence fails", async () => {
    const historyDone = Promise.withResolvers<void>();
    historyMockState.updateSessionHistoryData.mockImplementation(async () => {
      historyDone.resolve();
      return { updatedSessionSummary: false };
    });
    const publishSessionSummaryInvalidated = vi.fn(async () => {});
    const service = makeChatDispatchService({ publishSessionSummaryInvalidated });

    const prepared = await service.prepareChatMessage(makeChatMessage(), "connection-1");
    if (!prepared.ok) { throw new Error(prepared.error.message); }
    const claimedTurn = service.claimPreparedMessage(prepared.value);
    await service.spawnClaimedTurn(claimedTurn);
    await historyDone.promise;
    await Promise.resolve();

    expect(publishSessionSummaryInvalidated).not.toHaveBeenCalled();
  });
});
