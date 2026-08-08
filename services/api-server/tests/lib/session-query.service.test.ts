import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SETTINGS, type ClientState } from "@repo/shared";
import type { UIMessage } from "ai";
import type { LatestPlanRepository } from "../../src/modules/session-agent/repositories/latest-plan.repository";
import type { MessageRepository } from "../../src/modules/session-agent/repositories/message.repository";
import type { SetupOutputRepository } from "../../src/modules/session-agent/repositories/setup-output.repository";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import { SessionQueryService } from "../../src/modules/session-agent/services/session-query.service";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    sessionId,
    userId: "123e4567-e89b-12d3-a456-426614174001",
    spriteName: null,
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    ...overrides,
  };
}

function createClientState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    repoFullName: "ben/repo",
    status: "ready",
    sessionSetupRun: null,
    agentSettings: { ...DEFAULT_AGENT_SETTINGS },
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
    createdAt: new Date("2026-06-05T00:00:00.000Z"),
    ...overrides,
  };
}

function createService(overrides: {
  serverState?: Partial<ServerState>;
  clientState?: Partial<ClientState>;
  messages?: UIMessage[];
  plan?: {
    plan: string;
    sourceMessageId: string | null;
    updatedAt: string;
  } | null;
  setupOutput?: { stdout: string; stderr: string };
} = {}) {
  const messageRepository = {
    getAllBySession: vi.fn(() => (overrides.messages ?? []).map((message) => ({
      sessionId,
      createdAt: "2026-06-05T00:00:00.000Z",
      message,
    }))),
  } as unknown as MessageRepository;
  const latestPlanRepository = {
    getBySession: vi.fn(() => {
      if (overrides.plan === null) {
        return null;
      }
      const plan = overrides.plan ?? {
        plan: "Ship the refactor",
        sourceMessageId: "assistant-message-1",
        updatedAt: "2026-06-05T00:00:00.000Z",
      };
      return { sessionId, ...plan };
    }),
  } as unknown as LatestPlanRepository;
  const setupOutput = overrides.setupOutput ?? { stdout: "", stderr: "" };
  const setupOutputRepository = {
    read: vi.fn((stream: "stdout" | "stderr") => setupOutput[stream]),
    hasOutput: vi.fn(() => setupOutput.stdout.length > 0 || setupOutput.stderr.length > 0),
  } as unknown as SetupOutputRepository;
  const service = new SessionQueryService({
    messageRepository,
    latestPlanRepository,
    setupOutputRepository,
    getSetupOutputEpoch: () => "epoch-1",
    getServerState: () => createServerState(overrides.serverState),
    getClientState: () => createClientState(overrides.clientState),
  });

  return { latestPlanRepository, messageRepository, setupOutputRepository, service };
}

describe("SessionQueryService", () => {
  it("returns session info from current client and server state", () => {
    const { service } = createService({
      clientState: {
        baseBranch: "main",
        pushedBranch: "cloude/change",
        editorUrl: "https://sprite.example",
        pullRequest: {
          status: "created",
          url: "https://github.com/ben/repo/pull/1",
          number: 1,
          state: "open",
        },
      },
    });

    expect(service.handleGetSession()).toEqual({
      ok: true,
      value: {
        sessionId,
        title: null,
        status: "ready",
        repoFullName: "ben/repo",
        baseBranch: "main",
        pushedBranch: "cloude/change",
        pullRequestUrl: "https://github.com/ben/repo/pull/1",
        pullRequestNumber: 1,
        pullRequestState: "open",
        editorUrl: "https://sprite.example",
      },
    });
  });

  it("returns stored messages for initialized sessions", () => {
    const message: UIMessage = { id: "message-1", role: "user", parts: [] };
    const { messageRepository, service } = createService({ messages: [message] });

    expect(service.handleGetMessages()).toEqual({
      ok: true,
      value: [message],
    });
    expect(messageRepository.getAllBySession).toHaveBeenCalledWith(sessionId);
  });

  it("returns the latest stored plan", () => {
    const { latestPlanRepository, service } = createService();

    expect(service.handleGetPlan()).toEqual({
      ok: true,
      value: {
        plan: "Ship the refactor",
        updatedAt: "2026-06-05T00:00:00.000Z",
        sourceMessageId: "assistant-message-1",
      },
    });
    expect(latestPlanRepository.getBySession).toHaveBeenCalledWith(sessionId);
  });

  it("returns not initialized when session id is missing", () => {
    const { service } = createService({ serverState: { sessionId: null } });

    expect(service.handleGetSession()).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_INITIALIZED", message: "Session not found" },
    });
    expect(service.handleGetMessages()).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_INITIALIZED", message: "Session not found" },
    });
    expect(service.handleGetPlan()).toEqual({
      ok: false,
      error: { code: "SESSION_NOT_INITIALIZED", message: "Session not found" },
    });
  });

  it("returns plan not found when no plan is stored", () => {
    const { service } = createService({ plan: null });

    expect(service.handleGetPlan()).toEqual({
      ok: false,
      error: { code: "PLAN_NOT_FOUND", message: "Plan not found" },
    });
  });

  it("returns stored setup output while the script is running", () => {
    const { service } = createService({
      serverState: { startupScriptCompleted: false },
      setupOutput: { stdout: "installing...\n", stderr: "" },
    });

    expect(service.handleGetSetupOutput()).toEqual({
      ok: true,
      value: {
        taskId: "setup_script",
        epoch: "epoch-1",
        stdout: "installing...\n",
        stderr: "",
        truncated: false,
        completed: false,
      },
    });
  });

  it("returns completed setup output after the script finishes", () => {
    const { service } = createService({
      serverState: { startupScriptCompleted: true },
      setupOutput: { stdout: "done\n", stderr: "warn\n" },
    });

    expect(service.handleGetSetupOutput()).toEqual({
      ok: true,
      value: {
        taskId: "setup_script",
        epoch: "epoch-1",
        stdout: "done\n",
        stderr: "warn\n",
        truncated: false,
        completed: true,
      },
    });
  });

  it("returns setup output not found for completed runs with no stored output", () => {
    const { service } = createService({
      serverState: { startupScriptCompleted: true },
    });

    expect(service.handleGetSetupOutput()).toEqual({
      ok: false,
      error: { code: "SETUP_OUTPUT_NOT_FOUND", message: "Setup output not found" },
    });
  });
});
