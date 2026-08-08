import { describe, expect, it, vi } from "vitest";
import {
  failure,
  success,
  type Logger,
} from "@repo/shared";
import type { Env } from "../../src/shared/types";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import {
  SessionRepoAccessLifecycleService,
  type SessionRepoAccessChecker,
} from "../../src/runtime/session-repo-access-lifecycle.service";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const userId = "123e4567-e89b-12d3-a456-426614174001";

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

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    sessionId,
    userId,
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

function createHarness(overrides: {
  serverState?: Partial<ServerState>;
  assertSessionRepoAccess?: SessionRepoAccessChecker;
} = {}) {
  const env = {} as Env;
  const updatePartialState = vi.fn();
  const cancelActiveTurnAndClearState = vi.fn(async () => {});
  const killActiveProcess = vi.fn(async () => {});
  const checkSessionRepoAccess = overrides.assertSessionRepoAccess ??
    vi.fn<SessionRepoAccessChecker>().mockResolvedValue(success({
      userId,
      repoId: 42,
      installationId: 456,
      repoFullName: "ben/repo",
    }));
  const service = new SessionRepoAccessLifecycleService({
    logger: createLogger(),
    env,
    getServerState: () => createServerState(overrides.serverState),
    updatePartialState,
    cancelActiveTurnAndClearState,
    killActiveProcess,
    assertSessionRepoAccess: checkSessionRepoAccess,
  });

  return {
    checkSessionRepoAccess,
    cancelActiveTurnAndClearState,
    env,
    killActiveProcess,
    service,
    updatePartialState,
  };
}

describe("SessionRepoAccessLifecycleService", () => {
  it("returns session not found without calling the checker when ids are missing", async () => {
    const { checkSessionRepoAccess, service } = createHarness({
      serverState: { sessionId: null },
    });

    await expect(service.assertSessionRepoAccess()).resolves.toEqual({
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        status: 404,
        message: "Session not found",
      },
    });
    expect(checkSessionRepoAccess).not.toHaveBeenCalled();
  });

  it("delegates repo access checks with current session ids", async () => {
    const { checkSessionRepoAccess, env, service } = createHarness();

    await expect(service.assertSessionRepoAccess()).resolves.toEqual({
      ok: true,
      value: {
        userId,
        repoId: 42,
        installationId: 456,
        repoFullName: "ben/repo",
      },
    });
    expect(checkSessionRepoAccess).toHaveBeenCalledWith({
      env,
      logger: expect.any(Object),
      sessionId,
      userId,
    });
  });

  it("returns a repo-blocked operation message and enforces local blocked state", async () => {
    const {
      cancelActiveTurnAndClearState,
      killActiveProcess,
      service,
      updatePartialState,
    } = createHarness({
      assertSessionRepoAccess: vi.fn<SessionRepoAccessChecker>().mockResolvedValue(failure({
        code: "REPO_ACCESS_BLOCKED",
        status: 403,
        message: "The GitHub App installation no longer has access to this repository.",
        justBlocked: true,
      })),
    });

    await expect(service.guardSessionRepoAccess()).resolves.toEqual({
      ok: false,
      message: {
        type: "operation.error",
        code: "REPO_ACCESS_BLOCKED",
        message: "The GitHub App installation no longer has access to this repository.",
      },
    });
    expect(updatePartialState).toHaveBeenCalledWith({
      lastError: "Repository access for this session is blocked. Update the GitHub App installation or your GitHub access to continue.",
    });
    expect(cancelActiveTurnAndClearState).toHaveBeenCalledOnce();
    expect(killActiveProcess).toHaveBeenCalledOnce();
  });

  it("returns an auth-required operation message without blocked cleanup", async () => {
    const {
      cancelActiveTurnAndClearState,
      killActiveProcess,
      service,
      updatePartialState,
    } = createHarness({
      assertSessionRepoAccess: vi.fn<SessionRepoAccessChecker>().mockResolvedValue(failure({
        code: "GITHUB_AUTH_REQUIRED",
        status: 401,
        message: "GitHub authentication required",
      })),
    });

    await expect(service.guardSessionRepoAccess()).resolves.toEqual({
      ok: false,
      message: {
        type: "operation.error",
        code: "GITHUB_AUTH_REQUIRED",
        message: "GitHub authentication required",
      },
    });
    expect(updatePartialState).not.toHaveBeenCalled();
    expect(cancelActiveTurnAndClearState).not.toHaveBeenCalled();
    expect(killActiveProcess).not.toHaveBeenCalled();
  });

  it("returns a broadcast message when enforcing blocked access with notification", async () => {
    const {
      cancelActiveTurnAndClearState,
      killActiveProcess,
      service,
      updatePartialState,
    } = createHarness();

    await expect(service.enforceSessionAccessBlocked()).resolves.toEqual({
      type: "operation.error",
      code: "REPO_ACCESS_BLOCKED",
      message: "Repository access for this session is blocked. Update the GitHub App installation or your GitHub access to continue.",
    });
    expect(updatePartialState).toHaveBeenCalledWith({
      lastError: "Repository access for this session is blocked. Update the GitHub App installation or your GitHub access to continue.",
    });
    expect(cancelActiveTurnAndClearState).toHaveBeenCalledOnce();
    expect(killActiveProcess).toHaveBeenCalledOnce();
  });
});
