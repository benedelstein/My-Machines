import { describe, expect, it, vi } from "vitest";
import {
  ClientStateSchema,
  success,
  type ChatMessageEvent,
  type ClientState,
  type Result,
} from "@repo/shared";
import type { UIMessageChunk } from "ai";
import type { Connection } from "agents";
import { SessionAgentDO } from "../../src/runtime/session-agent.do";
import type { ClaimedTurn, PreparedChatMessage } from
  "../../src/modules/session-agent/services/session-chat-dispatch.service";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import type { Env } from "../../src/shared/types";
import type { InitSessionAgentRequest } from "../../src/shared/types/session-agent";
import {
  buildLegacyStartupToolchainContractHash,
  prepareStartupToolchain,
} from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service";
import type { FakeAgent } from "./session-agent-do-harness";
import {
  createFakeDurableObjectState,
  createFakeEnv,
  createTestDatabase,
  seedClientStateRow,
  seedServerStateRow,
} from "./session-agent-do-harness";
import { createTestLogger } from "./test-logger";

vi.mock("agents", async () => {
  const harness = await import("./session-agent-do-harness");
  return { Agent: harness.FakeAgent, getAgentByName: vi.fn() };
});

const USER_MESSAGE_ID = "123e4567-e89b-42d3-a456-426614174010";

function createClientState(overrides: Partial<ClientState> = {}): ClientState {
  return ClientStateSchema.parse({
    repoFullName: "owner/repo",
    status: "ready",
    sessionSetupRun: {
      id: "setup-1",
      status: "completed",
      startedAt: "2026-07-31T00:00:00.000Z",
      completedAt: "2026-07-31T00:01:00.000Z",
      tasks: [],
    },
    agentSettings: { provider: "claude-code" },
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
    baseBranch: "main",
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  });
}

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    teardownStarted: false,
    sessionId: "session-1",
    userId: "user-1",
    spriteName: "sprite-1",
    repoCloned: true,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    activeTurnDispatchStatus: null,
    startupToolchain: null,
    startupScriptCompleted: true,
    finalNetworkPolicyApplied: true,
    sessionConnectorId: "connector-1",
    spriteLabelsApplied: true,
    gitAuthMode: "ephemeral_token",
    ...overrides,
  };
}

interface TestAgentAccess {
  ensureRuntimeReadyAndDispatchNextTurn(
    prepared?: PreparedChatMessage,
  ): Promise<{ ok: boolean }>;
  handleUserChatMessage(
    connection: Connection,
    payload: ChatMessageEvent,
  ): Promise<void>;
  handleWebhookChunks(
    token: string,
    userMessageId: string,
    chunks: Array<{ sequence: number; chunk: UIMessageChunk }>,
  ): Promise<boolean>;
  handleInit(request: InitSessionAgentRequest): Promise<Result<void, object>>;
  initializeSessionState(
    request: InitSessionAgentRequest,
  ): Promise<Result<void, object>>;
  onConnect(connection: Connection): void;
  provisionService: {
    ensureProvisioned(...args: unknown[]): Promise<void>;
  };
  setupRunService: {
    repairBeforeProvisioning(): void;
  };
  runtimeMigrationCoordinator: {
    ensureMigrations(...args: unknown[]): Promise<Result<{
      outcome: "current" | "applied" | "deferred_active_turn";
    }, object>>;
    ensureMigration(...args: unknown[]): Promise<Result<{
      outcome: "current" | "applied" | "deferred_active_turn";
    }, object>>;
  };
  repoAccessLifecycleService: {
    guardSessionRepoAccess(): Promise<{ ok: true }>;
  };
  chatDispatchService: {
    prepareChatMessage(
      payload: ChatMessageEvent,
      connectionId: string,
    ): Promise<Result<PreparedChatMessage, never>>;
    recoverInterruptedClaim(): string | null;
    claimPendingMessage(): ClaimedTurn | null;
    claimPreparedMessage(prepared: PreparedChatMessage): ClaimedTurn;
    spawnClaimedTurn(claimedTurn: ClaimedTurn): Promise<Result<void, never>>;
  };
  secretRepository: {
    set(key: string, value: string): void;
  };
  sessionSummaryService: {
    persistWorkingState(state: "idle" | "responding"): void;
    persistAssistantTurnFinished(input: {
      messageId: string;
      messageCreatedAt: string;
      aborted: boolean;
    }): Promise<void>;
  };
  turnNotificationService: {
    publishTurnFinished(input: object): Promise<void>;
  };
  autoPullRequestService: {
    queueCreateAfterTurnFinish(): void;
  };
  providerConnectionService: {
    queueRefresh(): void;
  };
  testDatabase: ReturnType<typeof createTestDatabase>;
  turnCoordinator: {
    logger: {
      error(...args: unknown[]): void;
    };
  };
  serverState: ServerState;
}

function constructAgent(args: {
  serverState?: ServerState;
  clientState?: ClientState;
  useProductionMigrations?: boolean;
} = {}): TestAgentAccess & FakeAgent<Env, ClientState> {
  const database = createTestDatabase();
  seedServerStateRow(database, JSON.stringify(args.serverState ?? createServerState()));
  seedClientStateRow(database, JSON.stringify(args.clientState ?? createClientState()));
  const agent = new SessionAgentDO(
    createFakeDurableObjectState(database),
    createFakeEnv(),
  );
  const testAgent = agent as unknown as TestAgentAccess & FakeAgent<Env, ClientState>;
  testAgent.testDatabase = database;
  testAgent.sessionSummaryService = {
    persistWorkingState: vi.fn(),
    persistAssistantTurnFinished: vi.fn(async () => {}),
  };
  testAgent.turnNotificationService = {
    publishTurnFinished: vi.fn(async () => {}),
  };
  testAgent.autoPullRequestService = {
    queueCreateAfterTurnFinish: vi.fn(),
  };
  testAgent.providerConnectionService = {
    queueRefresh: vi.fn(),
  };
  testAgent.turnCoordinator.logger.error = vi.fn();
  if (!args.useProductionMigrations) {
    testAgent.runtimeMigrationCoordinator.ensureMigrations = vi.fn(async () =>
      success({ outcome: "current" as const }));
  }
  return testAgent;
}

function preparedChatMessage(): PreparedChatMessage {
  return {
    userMessage: {
      id: USER_MESSAGE_ID,
      role: "user",
      parts: [{ type: "text", text: "Fix the race" }],
    },
    content: "Fix the race",
    attachmentIds: [],
    connectionId: "connection-1",
    clientMessageId: "client-message-1",
    model: undefined,
    effort: undefined,
    agentMode: undefined,
  };
}

function connection(id: string): Connection {
  return { id, send: vi.fn() } as unknown as Connection;
}

describe("SessionAgentDO runtime boundary", () => {
  it("repairs setup state before provisioning", async () => {
    const agent = constructAgent();
    const events: string[] = [];
    agent.setupRunService.repairBeforeProvisioning = vi.fn(() => {
      events.push("repair");
    });
    agent.provisionService.ensureProvisioned = vi.fn(async () => {
      events.push("provision");
    });

    await agent.ensureRuntimeReadyAndDispatchNextTurn();

    expect(events).toEqual(["repair", "provision"]);
  });

  it("adopts a matching legacy toolchain checkpoint without a Sprite call", async () => {
    const prepared = prepareStartupToolchain({
      providerId: "claude-code",
      logger: createTestLogger(),
    });
    const contractHash = await buildLegacyStartupToolchainContractHash(prepared.contract);
    const agent = constructAgent({
      useProductionMigrations: true,
      serverState: createServerState({
        startupToolchain: { contractHash, checkedAt: 1, results: [] },
      }),
    });
    agent.provisionService.ensureProvisioned = vi.fn(async () => {});
    const ensureMigration = agent.runtimeMigrationCoordinator.ensureMigration.bind(
      agent.runtimeMigrationCoordinator,
    );
    agent.runtimeMigrationCoordinator.ensureMigrations = vi.fn(
      async (dependencies, lease) => ensureMigration(
        "sprite.startup-toolchain",
        dependencies,
        lease,
      ),
    );
    expect(agent.testDatabase.prepare(
      "SELECT migration_id FROM session_runtime_migrations",
    ).all()).toEqual([]);

    const result = await agent.ensureRuntimeReadyAndDispatchNextTurn();
    const rows = agent.testDatabase.prepare(
      "SELECT migration_id, status FROM session_runtime_migrations",
    ).all();

    expect(result).toEqual({ ok: true, value: { outcome: "ready" } });
    expect(rows).toEqual([{
      migration_id: "sprite.startup-toolchain",
      status: "applied",
    }]);
  });

  it("preserves the teardown guard across Durable Object reconstruction", async () => {
    const agent = constructAgent({
      serverState: createServerState({ teardownStarted: true }),
    });
    agent.provisionService.ensureProvisioned = vi.fn(async () => {});

    const result = await agent.ensureRuntimeReadyAndDispatchNextTurn();

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_MIGRATION_FAILED" },
    });
    expect(agent.provisionService.ensureProvisioned).not.toHaveBeenCalled();
    expect(agent.testDatabase.prepare(
      "SELECT migration_id FROM session_runtime_migrations",
    ).all()).toEqual([]);
  });

  it("runs the empty migration engine after terminal setup and before admission", async () => {
    const agent = constructAgent();
    const events: string[] = [];
    agent.provisionService.ensureProvisioned = vi.fn(async () => {
      events.push("provision");
    });
    agent.runtimeMigrationCoordinator.ensureMigrations = vi.fn(async () => {
      events.push("migrations");
      return success({ outcome: "current" as const });
    });
    agent.chatDispatchService.claimPendingMessage = vi.fn(() => {
      events.push("claim");
      return null;
    });

    await agent.ensureRuntimeReadyAndDispatchNextTurn();

    expect(events).toEqual(["provision", "migrations", "claim"]);
  });

  it("does not admit work when the migration range defers for an active turn", async () => {
    const agent = constructAgent();
    agent.runtimeMigrationCoordinator.ensureMigrations = vi.fn(async () =>
      success({ outcome: "deferred_active_turn" as const }));
    const claimPendingMessage = vi.fn(() => null);
    agent.chatDispatchService.claimPendingMessage = claimPendingMessage;

    const result = await agent.ensureRuntimeReadyAndDispatchNextTurn();

    expect(result).toEqual({ ok: true, value: { outcome: "deferred_active_turn" } });
    expect(claimPendingMessage).not.toHaveBeenCalled();
  });

  it("retries readiness after the terminal webhook clears the active turn", async () => {
    const agent = constructAgent({
      serverState: createServerState({
        activeUserMessageId: USER_MESSAGE_ID,
        activeTurnDispatchStatus: "dispatched",
        agentProcessId: 42,
        agentProcessRunId: "run-1",
      }),
      clientState: createClientState({
        activeTurn: { userMessageId: USER_MESSAGE_ID },
      }),
    });
    const ensureProvisioned = vi.fn(async () => {});
    agent.provisionService.ensureProvisioned = ensureProvisioned;
    agent.secretRepository.set("webhook_token", "webhook-token");
    const ensureMigrations = vi.spyOn(
      agent.runtimeMigrationCoordinator,
      "ensureMigrations",
    ).mockImplementation(async () => success({
      outcome: agent.serverState.activeUserMessageId
        ? "deferred_active_turn" as const
        : "current" as const,
    }));

    const deferred = await agent.ensureRuntimeReadyAndDispatchNextTurn();
    expect(deferred).toEqual({ ok: true, value: { outcome: "deferred_active_turn" } });
    expect(ensureProvisioned).toHaveBeenCalledOnce();
    expect(ensureMigrations).not.toHaveBeenCalled();

    await agent.handleWebhookChunks(
      "webhook-token",
      USER_MESSAGE_ID,
      [
        { sequence: 0, chunk: { type: "start", messageId: "assistant-1" } as UIMessageChunk },
        { sequence: 1, chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk },
      ],
    );

    await vi.waitFor(() => expect(ensureMigrations).toHaveBeenCalledOnce());
    expect(ensureProvisioned).toHaveBeenCalledTimes(2);
    expect(agent.serverState.activeUserMessageId).toBeNull();
  });

  it("serializes two connection readiness passes and reevaluates after the first", async () => {
    const agent = constructAgent();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const ensureProvisioned = vi.fn(async () => {
      if (ensureProvisioned.mock.calls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
    });
    agent.provisionService.ensureProvisioned = ensureProvisioned;

    agent.onConnect(connection("connection-1"));
    await firstEntered.promise;
    agent.onConnect(connection("connection-2"));

    expect(ensureProvisioned).toHaveBeenCalledOnce();

    releaseFirst.resolve();
    await vi.waitFor(() => expect(ensureProvisioned).toHaveBeenCalledTimes(2));
  });

  it("keeps initialization globally blocked but queues connection readiness on the runtime mutex", async () => {
    const agent = constructAgent({
      serverState: createServerState({
        initialized: false,
        sessionId: null,
        userId: null,
      }),
    });
    const initializationEntered = Promise.withResolvers<void>();
    const releaseInitialization = Promise.withResolvers<void>();
    agent.initializeSessionState = vi.fn(async () => {
      initializationEntered.resolve();
      await releaseInitialization.promise;
      agent.serverState = {
        ...agent.serverState,
        initialized: true,
        sessionId: "session-1",
        userId: "user-1",
      };
      return success(undefined);
    });
    const ensureProvisioned = vi.fn(async () => {});
    agent.provisionService.ensureProvisioned = ensureProvisioned;

    const init = agent.handleInit({} as InitSessionAgentRequest);
    await initializationEntered.promise;
    agent.onConnect(connection("connection-1"));

    expect(ensureProvisioned).not.toHaveBeenCalled();

    releaseInitialization.resolve();
    await init;
    await vi.waitFor(() => expect(ensureProvisioned).toHaveBeenCalledTimes(2));
  });

  it("queues chat admission behind readiness while attachment preparation stays outside", async () => {
    const agent = constructAgent();
    const readinessEntered = Promise.withResolvers<void>();
    const releaseReadiness = Promise.withResolvers<void>();
    const events: string[] = [];
    let provisionCalls = 0;
    let competingReadiness: Promise<{ ok: boolean }> | null = null;
    agent.provisionService.ensureProvisioned = vi.fn(async () => {
      provisionCalls += 1;
      events.push(`provision:${provisionCalls}`);
      if (provisionCalls === 1) {
        readinessEntered.resolve();
        await releaseReadiness.promise;
      }
      if (provisionCalls === 2) {
        queueMicrotask(() => {
          competingReadiness = agent.ensureRuntimeReadyAndDispatchNextTurn();
        });
      }
    });

    const prepareStarted = Promise.withResolvers<void>();
    const prepared = preparedChatMessage();
    const claimedTurn: ClaimedTurn = {
      userMessageId: USER_MESSAGE_ID,
      content: prepared.content,
      attachmentIds: [],
    };
    const claimPreparedMessage = vi.fn(() => {
      events.push("claim");
      return claimedTurn;
    });
    const spawnClaimedTurn = vi.fn(async () => {
      events.push("spawn");
      return success(undefined);
    });
    Object.assign(agent.chatDispatchService, {
      prepareChatMessage: vi.fn(async () => {
        prepareStarted.resolve();
        return success(prepared);
      }),
      recoverInterruptedClaim: vi.fn(() => null),
      claimPendingMessage: vi.fn(() => null),
      claimPreparedMessage,
      spawnClaimedTurn,
    });
    agent.repoAccessLifecycleService = {
      guardSessionRepoAccess: vi.fn(async () => ({ ok: true as const })),
    };

    const readiness = agent.ensureRuntimeReadyAndDispatchNextTurn();
    await readinessEntered.promise;
    const chat = agent.handleUserChatMessage(
      connection("connection-1"),
      {
        type: "chat.message",
        content: "Fix the race",
        clientMessageId: "client-message-1",
      },
    );
    await prepareStarted.promise;

    expect(claimPreparedMessage).not.toHaveBeenCalled();
    expect(spawnClaimedTurn).not.toHaveBeenCalled();

    releaseReadiness.resolve();
    await Promise.all([readiness, chat]);
    await vi.waitFor(() => expect(provisionCalls).toBe(3));
    if (competingReadiness) {
      await competingReadiness;
    }

    expect(claimPreparedMessage).toHaveBeenCalledWith(prepared);
    expect(spawnClaimedTurn).toHaveBeenCalledWith(claimedTurn);
    expect(events.indexOf("claim")).toBeGreaterThan(events.indexOf("provision:2"));
    expect(events.indexOf("claim")).toBeLessThan(events.indexOf("provision:3"));
  });

  it("admits a pending initial turn before a racing direct chat", async () => {
    const pendingMessage = {
      message: {
        id: USER_MESSAGE_ID,
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Initial request" }],
      },
      attachmentIds: [],
    };
    const agent = constructAgent({
      clientState: createClientState({ pendingUserMessage: pendingMessage }),
    });
    const readinessEntered = Promise.withResolvers<void>();
    const releaseReadiness = Promise.withResolvers<void>();
    let provisionCalls = 0;
    agent.provisionService.ensureProvisioned = vi.fn(async () => {
      provisionCalls += 1;
      if (provisionCalls === 1) {
        readinessEntered.resolve();
        await releaseReadiness.promise;
      }
    });
    const directPrepared = preparedChatMessage();
    agent.runtimeMigrationCoordinator.ensureMigrations = vi.fn(async () => success({
      outcome: agent.serverState.activeUserMessageId
        ? "deferred_active_turn" as const
        : "current" as const,
    }));
    const claimPreparedMessage = vi.fn((): ClaimedTurn => ({
      userMessageId: directPrepared.userMessage.id,
      content: directPrepared.content,
      attachmentIds: [],
    }));
    const claimPendingMessage = vi.fn((): ClaimedTurn | null => {
      if (agent.serverState.activeUserMessageId || !agent.state.pendingUserMessage) {
        return null;
      }
      agent.serverState = {
        ...agent.serverState,
        activeUserMessageId: USER_MESSAGE_ID,
        activeTurnDispatchStatus: "claimed",
      };
      Object.assign(agent.state, { pendingUserMessage: null });
      return {
        userMessageId: USER_MESSAGE_ID,
        content: "Initial request",
        attachmentIds: [],
      };
    });
    const spawnClaimedTurn = vi.fn(async () => success(undefined));
    Object.assign(agent.chatDispatchService, {
      prepareChatMessage: vi.fn(async () => success(directPrepared)),
      recoverInterruptedClaim: vi.fn(() => null),
      claimPendingMessage,
      claimPreparedMessage,
      spawnClaimedTurn,
    });
    agent.repoAccessLifecycleService = {
      guardSessionRepoAccess: vi.fn(async () => ({ ok: true as const })),
    };
    const directConnection = {
      id: "connection-1",
      send: vi.fn(),
    } as unknown as Connection;

    const readiness = agent.ensureRuntimeReadyAndDispatchNextTurn();
    await readinessEntered.promise;
    const chat = agent.handleUserChatMessage(
      directConnection,
      {
        type: "chat.message",
        content: "Racing request",
        clientMessageId: "client-message-1",
      },
    );
    releaseReadiness.resolve();
    await Promise.all([readiness, chat]);

    // The second readiness pass reaches the migration range with an active
    // pending turn and defers before attempting another claim.
    expect(claimPendingMessage).toHaveBeenCalledOnce();
    expect(claimPreparedMessage).not.toHaveBeenCalled();
    expect(spawnClaimedTurn).toHaveBeenCalledOnce();
    expect(directConnection.send).toHaveBeenCalledWith(expect.stringContaining(
      "Agent is already handling a message",
    ));
  });

  it("recovers a claimed turn after a Worker stop even when a reusable process id exists", async () => {
    const agent = constructAgent({
      serverState: createServerState({
        activeUserMessageId: USER_MESSAGE_ID,
        activeTurnDispatchStatus: "claimed",
        agentProcessId: 42,
        agentProcessRunId: "run-1",
      }),
    });

    const readiness = await agent.ensureRuntimeReadyAndDispatchNextTurn();

    expect(readiness.ok).toBe(true);
    expect(agent.serverState.activeUserMessageId).toBeNull();
    expect(agent.serverState.activeTurnDispatchStatus).toBeNull();
    expect(agent.serverState.agentProcessId).toBeNull();
  });

  it("lets a terminal webhook finish while readiness owns the application mutex", async () => {
    const agent = constructAgent({
      serverState: createServerState({
        activeUserMessageId: USER_MESSAGE_ID,
        activeTurnDispatchStatus: "dispatched",
        agentProcessId: 42,
        agentProcessRunId: "run-1",
      }),
      clientState: createClientState({
        activeTurn: { userMessageId: USER_MESSAGE_ID },
      }),
    });
    agent.secretRepository.set("webhook_token", "webhook-token");
    const boundaryEntered = Promise.withResolvers<void>();
    const releaseBoundary = Promise.withResolvers<void>();
    agent.provisionService.ensureProvisioned = vi.fn(async () => {
      boundaryEntered.resolve();
      await releaseBoundary.promise;
    });
    const readiness = agent.ensureRuntimeReadyAndDispatchNextTurn();
    await boundaryEntered.promise;

    const handled = await agent.handleWebhookChunks(
      "webhook-token",
      USER_MESSAGE_ID,
      [
        { sequence: 0, chunk: { type: "start", messageId: "assistant-1" } as UIMessageChunk },
        { sequence: 1, chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk },
      ],
    );

    expect(handled).toBe(true);
    expect(agent.serverState.activeUserMessageId).toBeNull();
    expect(agent.serverState.activeTurnDispatchStatus).toBeNull();

    releaseBoundary.resolve();
    await readiness;
  });
});
