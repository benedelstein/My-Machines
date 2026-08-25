import { vi } from "vitest";
import type { ProviderId, SessionEnvironmentSnapshot } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type {
  RuntimeMigrationDependencies,
  RuntimeMigrationServerState,
} from "../../src/modules/session-agent/types/runtime-migration-dependencies.types";
import { createTestLogger } from "./test-logger";

export interface TestRuntimeMigrationDependencies extends RuntimeMigrationDependencies {
  readonly createSpriteClient: ReturnType<typeof vi.fn>;
  readonly updateServerState: ReturnType<typeof vi.fn>;
}

/** Migration dependencies for coordinator and adopter tests, with spied writes. */
export function createMigrationDependencies(args: {
  activeUserMessageId?: string | null;
  teardownStarted?: boolean;
  serverState?: Partial<RuntimeMigrationServerState>;
  provider?: ProviderId;
  codexMinVersion?: string;
  sprite?: WorkersSpriteClient;
  environmentSnapshot?: SessionEnvironmentSnapshot;
} = {}): TestRuntimeMigrationDependencies {
  const serverState: RuntimeMigrationServerState = {
    activeUserMessageId: args.activeUserMessageId ?? null,
    finalNetworkPolicyApplied: false,
    gitAuthMode: "legacy_secret",
    repoCloned: true,
    sessionConnectorId: null,
    sessionId: "session-1",
    spriteName: "sprite-1",
    startupToolchain: null,
    ...args.serverState,
  };
  const clientState = {
    repoFullName: "ben/repo",
    agentSettings: { provider: args.provider ?? "openai-codex" },
  };

  return {
    getServerState: () => serverState,
    getClientState: () => clientState,
    updateServerState: vi.fn((partial: Partial<RuntimeMigrationServerState>) => {
      Object.assign(serverState, partial);
    }),
    isTeardownStarted: () => args.teardownStarted ?? false,
    createSpriteClient: vi.fn(() => args.sprite ?? ({} as WorkersSpriteClient)),
    getEnvironmentSnapshot: () => args.environmentSnapshot ?? {
      sourceEnvironmentId: null,
      sourceEnvironmentName: null,
      repoId: 1,
      network: { mode: "default" },
      plainEnvVars: {},
      startupScript: null,
      resolvedAt: "2026-05-29T00:00:00.000Z",
      schemaVersion: 1,
    },
    reconcileSessionSpriteLabels: vi.fn(async () => {}),
    reconcileSessionConnector: vi.fn(async () => {}),
    reconcileGitEphemeralTokenCutover: vi.fn(async () => {}),
    env: {
      CODEX_MIN_VERSION: args.codexMinVersion,
      SPRITES_API_URL: "https://api.sprites.test",
      WORKER_URL: "https://worker.test",
    },
    logger: createTestLogger(),
  };
}
