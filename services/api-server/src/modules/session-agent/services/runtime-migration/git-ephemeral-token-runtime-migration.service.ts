import { failure, success } from "@repo/shared";
import { logRuntimeMigrationApplyFailure } from
  "./runtime-migration-apply-failure.service";
import { defineVersionedRuntimeMigration } from "./runtime-migration-definition.service";

export const GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID =
  "sprite.git-ephemeral-token-cutover";

export const gitEphemeralTokenRuntimeMigration = defineVersionedRuntimeMigration({
  id: GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID,
  description: "Configure the existing clone for ephemeral Git tokens",
  version: 1,

  buildContext: (dependencies) => dependencies,

  apply: async ({ context }) => {
    try {
      await context.reconcileGitEphemeralTokenCutover();
      return success(undefined);
    } catch (error) {
      logRuntimeMigrationApplyFailure(
        context.logger,
        GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID,
        error,
      );
      return failure({
        code: "APPLY_FAILED",
        message: "Ephemeral Git token cutover apply or verification failed",
        migrationId: GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID,
      });
    }
  },
});
