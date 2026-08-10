import { failure, success } from "@repo/shared";
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
    } catch {
      return failure({
        code: "APPLY_FAILED",
        message: "Ephemeral Git token cutover apply or verification failed",
        migrationId: GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID,
      });
    }
  },
});
