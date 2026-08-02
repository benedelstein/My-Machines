import {
  failure,
  success,
  type Logger,
  type ProviderId,
} from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { StartupToolchainCheckpoint } from "@/shared/types/startup-toolchain";
import {
  ensurePreparedSpriteStartupToolchain,
  prepareStartupToolchain,
  type PreparedStartupToolchain,
} from "@/shared/integrations/sprite-startup-toolchain";
import type { RuntimeMigrationContext } from
  "@/modules/session-agent/types/runtime-migration.types";
import { defineContractRuntimeMigration } from "./runtime-migration-definition.service";

export const STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID = "sprite.startup-toolchain";

export interface StartupToolchainRuntimeMigrationTarget {
  readonly getPrepared: () => PreparedStartupToolchain;
  readonly sprite: WorkersSpriteClient;
  readonly checkpoint: StartupToolchainCheckpoint | null;
  readonly logger: Logger;
  readonly updateCheckpoint: (checkpoint: StartupToolchainCheckpoint) => void;
}

export type StartupToolchainRuntimeMigrationContext = RuntimeMigrationContext & {
  readonly startupToolchain: StartupToolchainRuntimeMigrationTarget;
};

function requireTarget(
  context: RuntimeMigrationContext,
): StartupToolchainRuntimeMigrationTarget {
  const startupContext = context as Partial<StartupToolchainRuntimeMigrationContext>;
  if (!startupContext.startupToolchain) {
    throw new Error("Startup toolchain migration context is missing");
  }
  return startupContext.startupToolchain;
}

/** Builds the per-readiness toolchain target with one shared check set. */
export function createStartupToolchainRuntimeMigrationTarget(args: {
  providerId: ProviderId;
  codexMinVersion?: string;
  sprite: WorkersSpriteClient;
  checkpoint: StartupToolchainCheckpoint | null;
  logger: Logger;
  updateCheckpoint: (checkpoint: StartupToolchainCheckpoint) => void;
}): StartupToolchainRuntimeMigrationTarget {
  let prepared: PreparedStartupToolchain | null = null;
  return {
    getPrepared: () => {
      prepared ??= prepareStartupToolchain({
        providerId: args.providerId,
        logger: args.logger,
        codexMinVersion: args.codexMinVersion,
      });
      return prepared;
    },
    sprite: args.sprite,
    checkpoint: args.checkpoint,
    logger: args.logger,
    updateCheckpoint: args.updateCheckpoint,
  };
}

/** Phase 4's sole production runtime migration definition. */
export const startupToolchainRuntimeMigration = defineContractRuntimeMigration({
  id: STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID,
  description: "Keep the provider runtime toolchain current",
  buildContract: (context) => requireTarget(context).getPrepared().contract,
  apply: async ({ context, desired }) => {
    const target = requireTarget(context);
    const prepared = target.getPrepared();
    const result = await ensurePreparedSpriteStartupToolchain({
      prepared: { ...prepared, contract: desired },
      sprite: target.sprite,
      checkpoint: target.checkpoint,
      logger: target.logger,
    });
    if (!result.ok) {
      return failure({
        code: "APPLY_FAILED",
        message: "Startup toolchain apply or verification failed",
        migrationId: STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID,
      });
    }
    if (result.value !== target.checkpoint) {
      target.updateCheckpoint(result.value);
    }
    return success(undefined);
  },
});
