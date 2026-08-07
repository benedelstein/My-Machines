import { failure, success, type Logger } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { StartupToolchainCheckpoint } from
  "@/modules/session-agent/types/startup-toolchain.types";
import {
  ensurePreparedSpriteStartupToolchain,
  prepareStartupToolchain,
  type PreparedStartupToolchain,
} from "./startup-toolchain/startup-toolchain.service";
import { defineContractRuntimeMigration } from "./runtime-migration-definition.service";

export const STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID = "sprite.startup-toolchain";

/** Everything the startup-toolchain migration needs from the live session. */
export interface StartupToolchainMigrationContext {
  /** Memoized so the hashed contract and the executed checks are one set. */
  readonly getPrepared: () => PreparedStartupToolchain;
  readonly sprite: WorkersSpriteClient;
  readonly checkpoint: StartupToolchainCheckpoint | null;
  readonly logger: Logger;
  readonly updateCheckpoint: (checkpoint: StartupToolchainCheckpoint) => void;
}

function once<T>(build: () => T): () => T {
  let value: T;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value;
  };
}

export const startupToolchainRuntimeMigration = defineContractRuntimeMigration({
  id: STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID,
  description: "Keep the provider runtime toolchain current",

  buildContext: (host): StartupToolchainMigrationContext => {
    const logger = host.logger.scope("startup-toolchain-runtime-migration");
    return {
      getPrepared: once(() => prepareStartupToolchain({
        providerId: host.getClientState().agentSettings.provider,
        codexMinVersion: host.env.CODEX_MIN_VERSION,
        logger,
      })),
      sprite: host.createSpriteClient(),
      checkpoint: host.getServerState().startupToolchain,
      logger,
      updateCheckpoint: (startupToolchain) => host.updateServerState({ startupToolchain }),
    };
  },

  buildContract: (context) => context.getPrepared().contract,

  apply: async ({ context, desired }) => {
    const result = await ensurePreparedSpriteStartupToolchain({
      prepared: { ...context.getPrepared(), contract: desired },
      sprite: context.sprite,
      checkpoint: context.checkpoint,
      logger: context.logger,
    });
    if (!result.ok) {
      return failure({
        code: "APPLY_FAILED",
        message: "Startup toolchain apply or verification failed",
        migrationId: STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID,
      });
    }
    if (result.value !== context.checkpoint) {
      context.updateCheckpoint(result.value);
    }
    return success(undefined);
  },
});
