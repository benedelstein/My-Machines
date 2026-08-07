import { vi } from "vitest";
import type { ProviderId } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type {
  RuntimeMigrationHost,
  RuntimeMigrationServerState,
} from "../../src/modules/session-agent/types/runtime-migration-host.types";
import { createTestLogger } from "./test-logger";

export interface TestRuntimeMigrationHost extends RuntimeMigrationHost {
  readonly createSpriteClient: ReturnType<typeof vi.fn>;
  readonly updateServerState: ReturnType<typeof vi.fn>;
}

/** Host for coordinator and adopter tests, with spied writes. */
export function createMigrationHost(args: {
  activeUserMessageId?: string | null;
  teardownStarted?: boolean;
  serverState?: Partial<RuntimeMigrationServerState>;
  provider?: ProviderId;
  codexMinVersion?: string;
  sprite?: WorkersSpriteClient;
} = {}): TestRuntimeMigrationHost {
  const serverState: RuntimeMigrationServerState = {
    activeUserMessageId: args.activeUserMessageId ?? null,
    spriteName: "sprite-1",
    startupToolchain: null,
    ...args.serverState,
  };
  const clientState = {
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
    env: { CODEX_MIN_VERSION: args.codexMinVersion },
    logger: createTestLogger(),
  };
}
