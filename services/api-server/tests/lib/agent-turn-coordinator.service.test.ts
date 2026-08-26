import { describe, expect, it, vi } from "vitest";
import type { ClientState, Logger } from "@repo/shared";
import type { UIMessage, UIMessageChunk } from "ai";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import {
  AgentTurnCoordinator,
  type FinishedAssistantTurn,
} from "../../src/modules/session-agent/services/agent-turn-coordinator.service";

function createLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope() {
      return this;
    },
  };
}

function createHarness(params: {
  onTurnFinished?: (turn: FinishedAssistantTurn) => void;
  onTurnSettled?: () => void;
} = {}) {
  const serverState = {
    sessionId: "session-1",
    activeUserMessageId: "user-message-1",
    activeTurnDispatchStatus: "dispatched",
    agentProcessId: 42,
    agentProcessRunId: "process-run-1",
  } as ServerState;
  const clientState = {
    status: "ready",
    sessionSetupRun: null,
    activeTurn: { userMessageId: "user-message-1", startedAt: "2026-06-03T00:00:00.000Z" },
    lastError: null,
  } as ClientState;
  const pendingChunkRepository = {
    getAll: vi.fn(() => []),
    appendIfNew: vi.fn((_chunk: UIMessageChunk, _sequence: number, _receivedAt: number) => true),
    clear: vi.fn(),
  };
  const broadcastMessage = vi.fn();
  const messageRepository = {
    create: vi.fn((sessionId: string, message: UIMessage) => ({
      sessionId,
      createdAt: "2026-06-03T00:00:00.000Z",
      message,
    })),
  };
  const updateWorkingState = vi.fn();
  const onTurnFinished = params.onTurnFinished ?? ((turn: FinishedAssistantTurn) => {
    if (turn.aborted) {
      updateWorkingState("idle");
    }
  });
  const onTurnSettled = params.onTurnSettled ?? vi.fn();

  const coordinator = new AgentTurnCoordinator({
    logger: createLogger(),
    env: {} as never,
    messageRepository: messageRepository as never,
    pendingChunkRepository: pendingChunkRepository as never,
    latestPlanRepository: {} as never,
    getServerState: () => serverState,
    updateServerState: (partial) => Object.assign(serverState, partial),
    getClientState: () => clientState,
    updatePartialState: (partial) => Object.assign(clientState, partial),
    broadcastMessage,
    synthesizeStatus: () => "preparing",
    terminateActiveProcess: vi.fn(),
    updateWorkingState,
    onTurnFinished,
    onTurnSettled,
  });

  return {
    broadcastMessage,
    clientState,
    coordinator,
    messageRepository,
    pendingChunkRepository,
    serverState,
    updateWorkingState,
    onTurnSettled,
  };
}

describe("AgentTurnCoordinator", () => {
  it("persists claimed and dispatched handoff states synchronously", () => {
    const { coordinator, serverState } = createHarness();

    coordinator.beginTurn("user-message-2");

    expect(serverState.activeUserMessageId).toBe("user-message-2");
    expect(serverState.activeTurnDispatchStatus).toBe("claimed");

    coordinator.markTurnDispatched("other-message", 99);
    expect(serverState.activeTurnDispatchStatus).toBe("claimed");

    coordinator.markTurnDispatched("user-message-2", 99);
    expect(serverState.agentProcessId).toBe(99);
    expect(serverState.activeTurnDispatchStatus).toBe("dispatched");
  });

  it("assigns one message id before persisting, broadcasting, and finalizing a legacy stream", async () => {
    const {
      broadcastMessage,
      coordinator,
      pendingChunkRepository,
    } = createHarness();

    await coordinator.handleChunks("user-message-1", [
      { sequence: 0, chunk: { type: "start" } as UIMessageChunk },
      { sequence: 1, chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk },
    ]);

    const persistedStart = pendingChunkRepository.appendIfNew.mock.calls[0]?.[0] as UIMessageChunk;
    expect(persistedStart.type).toBe("start");
    if (persistedStart.type !== "start") {
      throw new Error("Expected the persisted chunk to be a start chunk");
    }
    expect(persistedStart.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(broadcastMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "agent.chunks",
      chunks: [persistedStart, expect.objectContaining({ type: "finish" })],
    }));
    expect(broadcastMessage).toHaveBeenLastCalledWith({
      type: "agent.finish",
      message: expect.objectContaining({ id: persistedStart.messageId }),
    });
  });

  it("runs the turn-finished hook after broadcasting a terminal assistant message", async () => {
    const onTurnFinished = vi.fn();
    const {
      broadcastMessage,
      coordinator,
      messageRepository,
      serverState,
      updateWorkingState,
    } = createHarness({
      onTurnFinished,
    });

    await coordinator.handleChunks("user-message-1", [
      { sequence: 0, chunk: { type: "start", messageId: "assistant-message-1" } as UIMessageChunk },
      { sequence: 1, chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk },
    ]);

    expect(messageRepository.create).toHaveBeenCalledOnce();
    expect(broadcastMessage).toHaveBeenLastCalledWith({
      type: "agent.finish",
      message: expect.objectContaining({ id: "assistant-message-1" }),
    });
    expect(onTurnFinished).toHaveBeenCalledOnce();
    expect(onTurnFinished).toHaveBeenCalledWith({
      message: expect.objectContaining({ id: "assistant-message-1" }),
      messageCreatedAt: "2026-06-03T00:00:00.000Z",
      aborted: false,
    });
    expect(updateWorkingState).not.toHaveBeenCalledWith("idle");
    expect(serverState.activeUserMessageId).toBeNull();
  });

  it("queues readiness after a terminal webhook clears the active turn", async () => {
    const onTurnSettled = vi.fn();
    const { coordinator, serverState } = createHarness({ onTurnSettled });

    await coordinator.handleChunks("user-message-1", [
      { sequence: 0, chunk: { type: "start", messageId: "assistant-message-1" } as UIMessageChunk },
      { sequence: 1, chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk },
    ]);

    expect(serverState.activeUserMessageId).toBeNull();
    expect(serverState.activeTurnDispatchStatus).toBeNull();
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it("runs the turn-finished hook with abort for aborted assistant messages", async () => {
    const onTurnFinished = vi.fn();
    const { coordinator, updateWorkingState } = createHarness({ onTurnFinished });

    await coordinator.handleChunks("user-message-1", [
      { sequence: 0, chunk: { type: "start", messageId: "assistant-message-1" } as UIMessageChunk },
      { sequence: 1, chunk: { type: "abort" } as UIMessageChunk },
    ]);

    expect(onTurnFinished).toHaveBeenCalledWith({
      message: expect.objectContaining({ id: "assistant-message-1" }),
      messageCreatedAt: "2026-06-03T00:00:00.000Z",
      aborted: true,
    });
    expect(updateWorkingState).not.toHaveBeenCalledWith("idle");
  });

  it("clears the tracked agent process when the matching process exits", () => {
    const { coordinator, serverState } = createHarness();

    coordinator.handleEvent({
      type: "process_exit",
      processRunId: "process-run-1",
      exitCode: 0,
    });

    expect(serverState.agentProcessId).toBeNull();
    expect(serverState.agentProcessRunId).toBeNull();
  });

  it("aborts the active turn when the matching process exits mid-stream", async () => {
    const {
      broadcastMessage,
      clientState,
      coordinator,
      messageRepository,
      serverState,
      updateWorkingState,
    } = createHarness();

    await coordinator.handleChunks("user-message-1", [
      { sequence: 0, chunk: { type: "start", messageId: "assistant-message-1" } as UIMessageChunk },
      { sequence: 1, chunk: { type: "text-start", id: "text-1" } as UIMessageChunk },
      { sequence: 2, chunk: { type: "text-delta", id: "text-1", delta: "partial" } as UIMessageChunk },
    ]);

    coordinator.handleEvent({
      type: "process_exit",
      processRunId: "process-run-1",
      exitCode: 0,
    });

    expect(messageRepository.create).toHaveBeenCalledOnce();
    expect(broadcastMessage).toHaveBeenLastCalledWith({
      type: "agent.finish",
      message: expect.objectContaining({
        id: "assistant-message-1",
        metadata: expect.objectContaining({ aborted: true }),
      }),
    });
    expect(serverState.activeUserMessageId).toBeNull();
    expect(serverState.agentProcessId).toBeNull();
    expect(serverState.agentProcessRunId).toBeNull();
    expect(clientState.activeTurn).toBeNull();
    expect(updateWorkingState).toHaveBeenLastCalledWith("idle");
  });

  it("ignores stale process exit events from older runs", () => {
    const { coordinator, serverState } = createHarness();

    coordinator.handleEvent({
      type: "process_exit",
      processRunId: "old-process-run",
      exitCode: 0,
    });

    expect(serverState.agentProcessId).toBe(42);
    expect(serverState.agentProcessRunId).toBe("process-run-1");
  });
});
