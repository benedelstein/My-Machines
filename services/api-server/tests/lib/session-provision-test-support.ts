import { expect, vi } from "vitest";
import type {
  ClientState,
  SessionEnvironmentSnapshot,
  SessionSetupRun,
  SessionSetupTask,
} from "@repo/shared";
import { WorkersSpriteClient } from "@repo/sprites-client";
import type { Env } from "../../src/shared/types";
import type { RuntimeBoundaryLease } from
  "../../src/modules/session-agent/types/runtime-boundary.types";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import {
  SessionProvisionService,
  type SessionSetupTaskReporter,
} from "../../src/modules/session-agent/services/session-provision.service";
import type {
  SessionSetupOutputCollector,
} from "../../src/modules/session-agent/services/session-setup-output.service";
import { mockState } from "./session-provision-mocks";
import { createTestLogger } from "./test-logger";

export { mockState, resetProvisionMocks } from "./session-provision-mocks";
export { createTestLogger } from "./test-logger";

export const TEST_RUNTIME_BOUNDARY_LEASE = {} as RuntimeBoundaryLease;

export function createClientState(args: {
  prepareTask?: (task: SessionSetupTask) => SessionSetupTask;
  includeSessionConnector?: boolean;
} = {}): ClientState {
  return {
    repoFullName: "ben/repo",
    baseBranch: "main",
    agentSettings: {
      provider: "openai-codex",
      model: "gpt-5.5",
      maxTokens: 8192,
    },
    sessionSetupRun: createSetupRun(args.prepareTask, args.includeSessionConnector),
  } as ClientState;
}

export function createSetupRun(
  prepareTask?: (task: SessionSetupTask) => SessionSetupTask,
  includeSessionConnector = true,
): SessionSetupRun {
  const tasks = [
    createSetupTask("cloud_container", true),
    ...(includeSessionConnector
      ? [createSetupTask("session_connector", true)]
      : []),
    createSetupTask("repository", true),
    {
      ...createSetupTask("setup_script", false),
      output: null,
      skipReason: null,
    },
    createSetupTask("network_policy", true),
  ] as SessionSetupTask[];

  return {
    id: "setup-run-1",
    status: "running",
    startedAt: "2026-06-03T00:00:00.000Z",
    completedAt: null,
    tasks: prepareTask ? tasks.map(prepareTask) : tasks,
  };
}

export function createSetupTask<
  Id extends SessionSetupTask["id"],
  IsBlocking extends boolean,
>(id: Id, isBlocking: IsBlocking): Extract<SessionSetupTask, { id: Id }> {
  return {
    id,
    isBlocking,
    canRetry: id !== "setup_script",
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  } as Extract<SessionSetupTask, { id: Id }>;
}

export function completeTask(task: SessionSetupTask): SessionSetupTask {
  return {
    ...task,
    status: "completed",
    startedAt: "2026-06-03T00:00:00.000Z",
    completedAt: "2026-06-03T00:00:00.000Z",
    error: null,
  };
}

export function failTask(
  task: SessionSetupTask,
  error = "fatal failure",
): SessionSetupTask {
  return {
    ...task,
    status: "failed",
    startedAt: "2026-06-03T00:00:00.000Z",
    completedAt: "2026-06-03T00:00:00.000Z",
    error,
  };
}

export function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    sessionId: "session-1",
    userId: "user-1",
    spriteName: null,
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    sessionConnectorId: null,
    gitAuthMode: "legacy_secret",
    ...overrides,
  };
}

export function createEnvironmentSnapshot(
  overrides: Partial<SessionEnvironmentSnapshot> = {},
): SessionEnvironmentSnapshot {
  return {
    sourceEnvironmentId: null,
    sourceEnvironmentName: null,
    repoId: 1,
    network: { mode: "default" },
    plainEnvVars: {},
    startupScript: null,
    resolvedAt: "2026-05-29T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

export function createSetupReporter(): SessionSetupTaskReporter {
  return {
    startTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
    skipTask: vi.fn(),
  };
}

export function createService(
  serverState: ServerState,
  clientState: ClientState,
  envOverrides: Partial<Env> = {},
  environmentSnapshot: SessionEnvironmentSnapshot = createEnvironmentSnapshot(),
  setupReporter?: SessionSetupTaskReporter,
  setupOutputCollector?: SessionSetupOutputCollector,
) {
  const updateServerState = vi.fn((partial: Partial<ServerState>) => {
    Object.assign(serverState, partial);
  });
  const updatePartialState = vi.fn();
  const spriteLifecycleClient = {
    createSprite: vi.fn(async () => {
      mockState.events.push("createSprite");
      return {
        name: "sprite-1",
        status: "running",
        labels: ["session:session-1"],
      };
    }),
  };
  const discardFreshSpriteSnapshot = vi.fn();
  const onSpriteCreated = vi.fn();
  const retireGitProxySecret = vi.fn();
  const ensureSessionConnector = vi.fn(async () => {
    mockState.events.push("mintConnector");
    serverState.sessionConnectorId = "conn-1";
  });
  const serviceReference: { current: SessionProvisionService | null } = { current: null };
  const ensureRuntimeMigration = vi.fn(async (migrationId: string) => {
    switch (migrationId) {
      case "sprite.startup-toolchain": {
        const result = await mockState.ensureSpriteStartupToolchain({
          codexMinVersion: envOverrides.CODEX_MIN_VERSION,
        });
        if (!result.ok) {
          return {
            ok: false as const,
            error: {
              code: "APPLY_FAILED" as const,
              message: result.error.message,
              migrationId,
            },
          };
        }
        updateServerState({ startupToolchain: result.value });
        break;
      }
      case "session.connector-resource":
        await ensureSessionConnector();
        break;
      case "sprite.git-ephemeral-token-cutover":
        if (!serverState.sessionConnectorId) {
          await ensureSessionConnector();
        }
        await serviceReference.current?.reconcileGitEphemeralTokenCutover();
        break;
      case "sprite.network-policy":
        await serviceReference.current?.reconcileNetworkPolicy({
          contractSchema: 1,
          providerId: clientState.agentSettings.provider,
          requestedNetwork: environmentSnapshot.network,
          workerHostname: "worker.test",
          connectorGatewayHostname: "api.sprites.test",
          rules: [{ domain: "final", action: "allow" }],
        });
        break;
    }
    return { ok: true as const, value: { outcome: "applied" as const } };
  });
  const service = new SessionProvisionService({
    logger: createTestLogger(),
    env: {
      SPRITES_API_KEY: "sprites-key",
      SPRITES_API_URL: "https://api.sprites.test",
      WORKER_URL: "https://worker.test",
      ...envOverrides,
    } as Env,
    spriteLifecycleClient: spriteLifecycleClient as never,
    createSpriteClient: (spriteName) =>
      new WorkersSpriteClient(
        spriteName,
        "sprites-key",
        "https://api.sprites.test",
        createTestLogger(),
      ),
    getServerState: () => serverState,
    getClientState: () => clientState,
    getEnvironmentSnapshot: () => environmentSnapshot,
    updateServerState,
    updatePartialState,
    synthesizeStatus: () => "preparing",
    retireGitProxySecret,
    getSessionConnectorGatewayBase: () =>
      serverState.sessionConnectorId ? "https://gateway.test/conn-1" : null,
    discardFreshSpriteSnapshot,
    onSpriteCreated,
    ensureRuntimeMigration,
    githubTokenProvider: {
      getReadOnlyTokenForRepo: mockState.getReadOnlyTokenForRepo,
    },
    setupReporter,
    setupOutputCollector,
  });
  serviceReference.current = service;

  return {
    service,
    updateServerState,
    spriteLifecycleClient,
    retireGitProxySecret,
    ensureSessionConnector,
    ensureRuntimeMigration,
    discardFreshSpriteSnapshot,
    onSpriteCreated,
  };
}

export function getRemoteConfigCommand(): string {
  const remoteConfigCall = mockState.execWs.mock.calls.find(([command]) =>
    String(command).includes("git remote set-url origin"));
  expect(remoteConfigCall).toBeDefined();
  return String(remoteConfigCall?.[0]);
}
