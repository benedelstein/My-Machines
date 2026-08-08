import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SpritesClientModule from "@repo/sprites-client";
import type { AgentSettings, ClientState, SessionSetupRun } from "@repo/shared";
import type { Env } from "../../src/shared/types";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";

// FIXME - THESE TESTS TAKE VERY LONG.
const mockState = vi.hoisted(() => ({
  attachSession: vi.fn(),
  createSession: vi.fn(),
  execWs: vi.fn(),
  writeFile: vi.fn(),
  killSession: vi.fn(),
  getCredentialSnapshot: vi.fn(),
  resolveAttachments: vi.fn(),
}));

vi.mock("@repo/vm-agent/dist/vm-agent-webhook.bundle.js", () => ({
  default: "// mocked vm-agent bundle",
}));

vi.mock("@repo/sprites-client", () => {
  class SpritesError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public responseText?: string,
    ) {
      super(message);
    }
  }
  class WorkersSpriteClient {
    public name: string;
    constructor(name: string) {
      this.name = name;
    }
    attachSession = mockState.attachSession;
    createSession = mockState.createSession;
    execWs = mockState.execWs;
    writeFile = mockState.writeFile;
    killSession = mockState.killSession;
  }
  return { WorkersSpriteClient, SpritesError };
});

vi.mock("../../src/modules/session-agent/services/agent-attachment.service", () => ({
  AgentAttachmentService: class {
    resolveAttachments = mockState.resolveAttachments;
  },
}));

import { encodeAgentInput, encodeAgentOutput } from "@repo/shared";
import { createTestLogger } from "./test-logger";
import { SpriteAgentProcessManager } from "../../src/modules/session-agent/services/agent-process/sprite-agent-process-manager.service";

// The barrel is mocked above with its own SpritesError class; importActual
// preserves the pre-move behavior of deep-importing the real class.
const { SpritesError } = await vi.importActual<typeof SpritesClientModule>(
  "@repo/sprites-client",
);

const agentSettings: AgentSettings = {
  provider: "openai-codex",
  model: "gpt-5.3-codex",
  maxTokens: 8192,
  effort: "medium",
};

function createCompletedSetupRun(): SessionSetupRun {
  return {
    id: "setup-run-1",
    status: "completed",
    startedAt: "2026-06-03T00:00:00.000Z",
    completedAt: "2026-06-03T00:01:00.000Z",
    tasks: [],
  };
}

function createClientState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    sessionId: "session-1",
    status: "ready",
    sessionSetupRun: createCompletedSetupRun(),
    repoFullName: "ben/repo",
    repoUrl: "https://github.com/ben/repo",
    baseBranch: "main",
    branchName: "cloude/session-1",
    agentSettings,
    agentMode: "edit",
    messages: [],
    todos: null,
    plan: null,
    latestPr: null,
    editorUrl: null,
    lastError: null,
    pulledBranch: null,
    pullRequest: null,
    pushedBranch: null,
    pendingUserMessage: null,
    activeTurn: null,
    providerConnection: null,
    createdAt: new Date(),
    ...overrides,
  } as ClientState;
}

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sessionId: "session-1",
    userId: "user-1",
    spriteName: "sprite-1",
    repoCloned: true,
    agentSessionId: "provider-session-1",
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    webhookToken: null,
    ...overrides,
  } as ServerState;
}

function createManager(
  serverState: ServerState,
  envOverrides: Partial<Env> = {},
  snapshotPlainEnvVars: Record<string, string> = {},
  clientState: ClientState = createClientState(),
  connectorGatewayBase: string | null = null,
  loggerWarn: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const updateAgentProcessState = vi.fn(
    (partial: Pick<ServerState, "agentProcessId" | "agentProcessRunId">) => {
      Object.assign(serverState, partial);
    },
  );
  const clearProcessState = {
    agentProcessId: null,
    agentProcessRunId: null,
  };
  const spawnedProcessState = (agentProcessId: number) => ({
    agentProcessId,
    agentProcessRunId: expect.any(String),
  });
  const manager = new SpriteAgentProcessManager({
    env: {
      SPRITES_API_KEY: "sprites-key",
      SPRITES_API_URL: "https://api.sprites.test",
      WORKER_URL: "https://worker.test",
      ...envOverrides,
    } as Env,
    logger: createTestLogger({ warn: loggerWarn }),
    secretRepository: {
      get: vi.fn(() => "webhook-token"),
      set: vi.fn(),
      delete: vi.fn(),
    } as never,
    getServerState: () => serverState,
    updateAgentProcessState,
    getClientState: () => clientState,
    getEnvironmentSnapshot: () => ({
      sourceEnvironmentId: null,
      sourceEnvironmentName: null,
      repoId: 1,
      network: { mode: "default" },
      plainEnvVars: snapshotPlainEnvVars,
      startupScript: null,
      resolvedAt: "2026-05-29T00:00:00.000Z",
      schemaVersion: 1,
    }),
    getProviderCredentialAdapter: () => ({
      getCredentialSnapshot: mockState.getCredentialSnapshot,
    }),
    getConnectorGatewayBase: () => connectorGatewayBase,
  });

  return {
    clearProcessState,
    manager,
    spawnedProcessState,
    updateAgentProcessState,
    loggerWarn,
  };
}

function createSpawnSession(args: {
  sessionId?: number;
  readyChunks?: string[];
  exitCode?: number;
  startReject?: unknown;
} = {}) {
  let serverMessageHandler: ((message: unknown) => void) | undefined;
  let stdoutHandler: ((chunk: string) => void) | undefined;
  let exitHandler: ((code: number) => void) | undefined;
  const readyChunks = args.readyChunks ?? [encodeAgentOutput({ type: "ready" }) + "\n"];

  return {
    start: vi.fn(async () => {
      if (args.startReject) { throw args.startReject; }
      serverMessageHandler?.({
        type: "session_info",
        session_id: args.sessionId ?? 84,
        tty: true,
      });
      for (const chunk of readyChunks) { stdoutHandler?.(chunk); }
      if (args.exitCode !== undefined) { exitHandler?.(args.exitCode); }
    }),
    close: vi.fn(),
    onServerMessage: vi.fn((handler) => {
      serverMessageHandler = handler;
      return vi.fn();
    }),
    onStdout: vi.fn((handler) => {
      stdoutHandler = handler;
      return vi.fn();
    }),
    onError: vi.fn(() => vi.fn()),
    onExit: vi.fn((handler) => {
      exitHandler = handler;
      return vi.fn();
    }),
  };
}

describe("SpriteAgentProcessManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockState.getCredentialSnapshot.mockResolvedValue({
      ok: true,
      value: { envVars: {}, files: [] },
    });
    mockState.resolveAttachments.mockResolvedValue({
      ok: true,
      value: { agentAttachments: [] },
    });
    mockState.execWs.mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
    mockState.writeFile.mockResolvedValue(undefined);
    mockState.killSession.mockResolvedValue(undefined);
  });

  it("gracefully cancels the active turn with a matching cancel ack", async () => {
    let stdoutHandler: ((chunk: string) => void) | undefined;
    const existingSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        stdoutHandler?.(
          encodeAgentOutput({
            type: "cancel_ack",
            userMessageId: "user-message-2",
          }) + "\n",
        );
      }),
      close: vi.fn(),
      onStdout: vi.fn((handler) => {
        stdoutHandler = handler;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
    };
    mockState.attachSession.mockReturnValue(existingSession);

    const serverState = createServerState({
      agentProcessId: 42,
      activeUserMessageId: "user-message-2",
    });
    const { clearProcessState, manager, updateAgentProcessState } = createManager(serverState);

    const result = await manager.cancelActiveTurn();

    expect(result).toEqual({ processPreserved: true });
    expect(existingSession.write).toHaveBeenCalledWith(
      encodeAgentInput({ type: "cancel", userMessageId: "user-message-2" }) + "\n",
    );
    expect(mockState.killSession).not.toHaveBeenCalled();
    expect(updateAgentProcessState).not.toHaveBeenCalledWith(clearProcessState);
  });

  it("kills the active process when cancel ack times out", async () => {
    vi.useFakeTimers();
    let stdoutHandler: ((chunk: string) => void) | undefined;
    const existingSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        stdoutHandler?.(
          encodeAgentOutput({
            type: "cancel_ack",
            userMessageId: "different-message",
          }) + "\n",
        );
      }),
      close: vi.fn(),
      onStdout: vi.fn((handler) => {
        stdoutHandler = handler;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
    };
    mockState.attachSession.mockReturnValue(existingSession);

    const serverState = createServerState({
      agentProcessId: 42,
      activeUserMessageId: "user-message-2",
    });
    const { clearProcessState, manager, updateAgentProcessState } = createManager(serverState);

    const cancelPromise = manager.cancelActiveTurn();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await cancelPromise;

    expect(result).toEqual({ processPreserved: false });
    expect(mockState.killSession).toHaveBeenCalledWith(42, "SIGTERM");
    expect(updateAgentProcessState).toHaveBeenCalledWith(clearProcessState);
    vi.useRealTimers();
  });

  it("attaches to an idle vm-agent process and sends the new message on stdin", async () => {
    let stdoutHandler: ((chunk: string) => void) | undefined;
    const existingSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        stdoutHandler?.("debug log\n");
        stdoutHandler?.(
          encodeAgentOutput({
            type: "stdin_ack",
            userMessageId: "user-message-2",
          }) + "\n",
        );
      }),
      close: vi.fn(),
      onStdout: vi.fn((handler) => {
        stdoutHandler = handler;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
    };
    mockState.attachSession.mockReturnValue(existingSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const { clearProcessState, manager, updateAgentProcessState } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-2", content: "second turn", attachmentIds: [] },
      model: "gpt-5.2-codex",
      agentMode: "plan",
    });

    expect(result.ok).toBe(true);
    expect(mockState.attachSession).toHaveBeenCalledWith("42", { idleTimeoutMs: 10_000 });
    expect(existingSession.start).toHaveBeenCalledOnce();
    expect(existingSession.write).toHaveBeenCalledWith(
      encodeAgentInput({
        type: "chat",
        userMessageId: "user-message-2",
        message: { content: "second turn" },
        model: "gpt-5.2-codex",
        agentMode: "plan",
      }) + "\n",
    );
    expect(existingSession.close).toHaveBeenCalledOnce();
    expect(mockState.createSession).not.toHaveBeenCalled();
    expect(updateAgentProcessState).not.toHaveBeenCalledWith(clearProcessState);
  });

  it("refuses to dispatch before the setup run completes", async () => {
    const serverState = createServerState();
    const clientState = createClientState({
      sessionSetupRun: {
        ...createCompletedSetupRun(),
        status: "running",
        completedAt: null,
      },
    });
    const { manager } = createManager(serverState, {}, {}, clientState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-2", content: "second turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_NOT_READY");
    }
    expect(mockState.attachSession).not.toHaveBeenCalled();
    expect(mockState.createSession).not.toHaveBeenCalled();
  });

  it("waits for a stdin ack split across stdout chunks", async () => {
    let stdoutHandler: ((chunk: string) => void) | undefined;
    const existingSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        const ackLine =
          encodeAgentOutput({
            type: "stdin_ack",
            userMessageId: "user-message-2",
          }) + "\n";
        stdoutHandler?.(ackLine.slice(0, 12));
        stdoutHandler?.(ackLine.slice(12));
      }),
      close: vi.fn(),
      onStdout: vi.fn((handler) => {
        stdoutHandler = handler;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
    };
    mockState.attachSession.mockReturnValue(existingSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const { clearProcessState, manager, updateAgentProcessState } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-2", content: "second turn", attachmentIds: [] },
      model: "gpt-5.2-codex",
      agentMode: "plan",
    });

    expect(result.ok).toBe(true);
    expect(existingSession.write).toHaveBeenCalledWith(
      encodeAgentInput({
        type: "chat",
        userMessageId: "user-message-2",
        message: { content: "second turn" },
        model: "gpt-5.2-codex",
        agentMode: "plan",
      }) + "\n",
    );
    expect(existingSession.close).toHaveBeenCalledOnce();
    expect(mockState.createSession).not.toHaveBeenCalled();
    expect(updateAgentProcessState).not.toHaveBeenCalledWith(clearProcessState);
  });

  it("spawns a fresh process when an attached process exits after stdin write without ack", async () => {
    let exitHandler: ((code: number) => void) | undefined;
    const uncertainSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        exitHandler?.(1);
      }),
      close: vi.fn(),
      onStdout: vi.fn(() => vi.fn()),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn((handler) => {
        exitHandler = handler;
        return vi.fn();
      }),
    };
    const spawnSession = createSpawnSession();
    mockState.attachSession.mockReturnValue(uncertainSession);
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const {
      clearProcessState,
      manager,
      spawnedProcessState,
      updateAgentProcessState,
    } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(updateAgentProcessState).toHaveBeenCalledWith(clearProcessState);
    expect(mockState.killSession).toHaveBeenCalledWith(42, "SIGTERM");
    expect(mockState.createSession).toHaveBeenCalledOnce();
    expect(updateAgentProcessState).toHaveBeenLastCalledWith(spawnedProcessState(84));
  });

  it("fails when an attached process does not ack and cannot be stopped", async () => {
    let exitHandler: ((code: number) => void) | undefined;
    const uncertainSession = {
      start: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => {
        exitHandler?.(1);
      }),
      close: vi.fn(),
      onStdout: vi.fn(() => vi.fn()),
      onError: vi.fn(() => vi.fn()),
      onExit: vi.fn((handler) => {
        exitHandler = handler;
        return vi.fn();
      }),
    };
    mockState.attachSession.mockReturnValue(uncertainSession);
    mockState.killSession.mockRejectedValue(new Error("kill failed"));

    const serverState = createServerState({ agentProcessId: 42 });
    const { clearProcessState, manager, updateAgentProcessState } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TURN_DID_NOT_START");
    }
    expect(updateAgentProcessState).toHaveBeenCalledWith(clearProcessState);
    expect(mockState.killSession).toHaveBeenCalledWith(42, "SIGTERM");
    expect(mockState.createSession).not.toHaveBeenCalled();
  });

  it("resets a stale process id and falls back to spawning when attach returns 404", async () => {
    const staleSession = {
      start: vi.fn().mockRejectedValue(new SpritesError("not found", 404)),
      write: vi.fn(),
      close: vi.fn(),
      onServerMessage: vi.fn((handler) => {
        handler({ type: "session_info", session_id: 84, tty: true });
        return vi.fn();
      }),
    };
    const spawnSession = createSpawnSession();
    mockState.attachSession.mockReturnValue(staleSession);
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const {
      clearProcessState,
      manager,
      spawnedProcessState,
      updateAgentProcessState,
    } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(updateAgentProcessState).toHaveBeenCalledWith(clearProcessState);
    expect(mockState.createSession).toHaveBeenCalledOnce();
    expect(updateAgentProcessState).toHaveBeenLastCalledWith(spawnedProcessState(84));
  });

  it("waits for a fresh process ready line split across stdout chunks", async () => {
    const readyLine = encodeAgentOutput({ type: "ready" }) + "\n";
    const spawnSession = createSpawnSession({
      sessionId: 91,
      readyChunks: [readyLine.slice(0, 7), readyLine.slice(7)],
    });
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState();
    const { manager, spawnedProcessState, updateAgentProcessState } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(updateAgentProcessState).toHaveBeenLastCalledWith(spawnedProcessState(91));
  });

  it("returns TURN_DID_NOT_START when a fresh process exits before ready", async () => {
    const spawnSession = createSpawnSession({ readyChunks: [], exitCode: 1 });
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState();
    const { manager, updateAgentProcessState } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TURN_DID_NOT_START");
      expect(result.error.message).toBe("vm-agent exited before vm-agent ready: 1");
    }
    expect(updateAgentProcessState).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentProcessId: 84 }),
    );
  });

  it("emits a fresh start failure when provider credentials are unavailable", async () => {
    mockState.getCredentialSnapshot.mockResolvedValue({
      ok: false,
      error: {
        domain: "provider_credential",
        code: "AUTH_REQUIRED",
        message: "Connect OpenAI Codex",
        provider: "openai-codex",
      },
    });
    const serverState = createServerState();
    const { manager } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROVIDER_AUTH_REQUIRED");
    }
    expect(mockState.createSession).not.toHaveBeenCalled();
  });

  it("emits a fresh start failure when initial attachment resolution fails", async () => {
    mockState.resolveAttachments.mockResolvedValue({
      ok: false,
      error: {
        code: "ATTACHMENTS_RESOLUTION_FAILED",
        message: "Failed to resolve attachments",
        attachmentIds: ["00000000-0000-0000-0000-000000000001"],
      },
    });
    const serverState = createServerState();
    const { manager } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: {
        id: "user-message-3",
        content: "fresh turn",
        attachmentIds: ["00000000-0000-0000-0000-000000000001"],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ATTACHMENTS_RESOLUTION_FAILED");
    }
    expect(mockState.createSession).not.toHaveBeenCalled();
  });

  it("times out when a fresh process does not emit ready within thirty seconds", async () => {
    vi.useFakeTimers();
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const spawnSession = createSpawnSession({ readyChunks: [] });
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState();
    const { manager } = createManager(serverState);

    try {
      const resultPromise = manager.dispatchMessage({
        userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
      });
      // dispatchMessage awaits a real crypto.subtle digest before spawning, so
      // poll with waitFor instead of a fixed number of fake-timer flushes.
      await vi.waitFor(() => {
        expect(spawnSession.start).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TURN_DID_NOT_START");
        expect(result.error.message).toBe("Timed out waiting for vm-agent ready");
      }
    } finally {
      digestSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves the bun exit status when piping output through tee", async () => {
    const spawnSession = createSpawnSession();
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState();
    const { manager } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(mockState.createSession).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "-c",
        expect.stringContaining("set -o pipefail && bun \"$@\" 2>&1 | tee -a"),
      ]),
      expect.any(Object),
    );
  });

  it("passes CODEX_MIN_VERSION to fresh vm-agent processes when configured", async () => {
    const spawnSession = createSpawnSession();
    mockState.attachSession.mockReturnValue({
      start: vi.fn().mockRejectedValue(new SpritesError("not found", 404)),
      close: vi.fn(),
    });
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const { manager } = createManager(serverState, {
      CODEX_MIN_VERSION: "0.140.0",
    });

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(mockState.createSession).toHaveBeenCalledOnce();
    expect(mockState.createSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_MIN_VERSION: "0.140.0",
        }),
      }),
    );
  });

  it("preserves control-plane webhook env vars when snapshot env vars use reserved names", async () => {
    const spawnSession = createSpawnSession();
    mockState.attachSession.mockReturnValue({
      start: vi.fn().mockRejectedValue(new SpritesError("not found", 404)),
      close: vi.fn(),
    });
    mockState.createSession.mockReturnValue(spawnSession);

    const serverState = createServerState({ agentProcessId: 42 });
    const { manager } = createManager(serverState, {}, {
      SESSION_ID: "user-session",
      DO_WEBHOOK_URL: "https://evil.test",
      DO_WEBHOOK_TOKEN: "user-token",
      DO_WEBHOOK_AUTH: "gateway",
      AGENT_PROCESS_RUN_ID: "user-run",
    });

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-3", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    expect(mockState.createSession).toHaveBeenCalledOnce();
    expect(mockState.createSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          SESSION_ID: "session-1",
          DO_WEBHOOK_URL: "https://worker.test/internal/session/session-1",
          DO_WEBHOOK_TOKEN: "webhook-token",
          DO_WEBHOOK_AUTH: "bearer",
          AGENT_PROCESS_RUN_ID: expect.any(String),
        }),
      }),
    );
  });

  it("returns a spawn failure when sprite setup file writes fail", async () => {
    mockState.getCredentialSnapshot.mockResolvedValue({
      ok: true,
      value: {
        envVars: {},
        files: [
          {
            path: "/home/sprite/.codex/auth.json",
            contents: "{}",
            mode: "0600",
          },
        ],
      },
    });
    mockState.writeFile.mockRejectedValue(
      new SpritesError("Failed to write file /home/sprite/.codex/auth.json: 503", 503),
    );

    const serverState = createServerState();
    const { manager } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-4", content: "fresh turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPAWN_FAILED");
      expect(result.error.message).toBe(
        "Failed to write file /home/sprite/.codex/auth.json: 503",
      );
    }
    expect(mockState.createSession).not.toHaveBeenCalled();
  });

  it("falls back to sprite-held token delivery for sessions without a connector", async () => {
    mockState.createSession.mockReturnValue(createSpawnSession());
    const serverState = createServerState();
    const { manager, loggerWarn } = createManager(serverState);

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-1", content: "turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    const spawnEnv = getSpawnEnv();
    expect(spawnEnv.DO_WEBHOOK_URL).toBe("https://worker.test/internal/session/session-1");
    expect(spawnEnv.DO_WEBHOOK_TOKEN).toBe("webhook-token");
    expect(spawnEnv.DO_WEBHOOK_AUTH).toBe("bearer");
    // The Sprite still holds the token on this legacy path; never silent.
    expect(loggerWarn).toHaveBeenCalledWith(
      "Session has no connector; using sprite-held webhook token",
      { fields: { sessionId: "session-1", delivery: "sprite_held_token" } },
    );
  });

  it("hands the VM the connector gateway base when a connector exists", async () => {
    mockState.createSession.mockReturnValue(createSpawnSession());
    const serverState = createServerState({ sessionConnectorId: "conn-1" });
    const { manager } = createManager(
      serverState,
      {},
      {},
      createClientState(),
      "https://api.sprites.test/v1/gateway/custom_api/conn-1",
    );

    const result = await manager.dispatchMessage({
      userMessage: { id: "user-message-1", content: "turn", attachmentIds: [] },
    });

    expect(result.ok).toBe(true);
    const spawnEnv = getSpawnEnv();
    expect(spawnEnv.DO_WEBHOOK_URL).toBe(
      "https://api.sprites.test/v1/gateway/custom_api/conn-1/internal/session/session-1",
    );
    expect(spawnEnv.DO_WEBHOOK_TOKEN).toBe("");
    expect(spawnEnv.DO_WEBHOOK_AUTH).toBe("gateway");
  });
});

function getSpawnEnv(): Record<string, string | undefined> {
  const spawnCall = mockState.createSession.mock.calls[0];
  expect(spawnCall).toBeDefined();
  return (spawnCall?.[2] as { env: Record<string, string | undefined> }).env;
}
