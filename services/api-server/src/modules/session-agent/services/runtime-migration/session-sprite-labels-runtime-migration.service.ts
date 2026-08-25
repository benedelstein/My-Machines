import { failure, success } from "@repo/shared";
import type { SessionSpriteLabelsContract } from
  "@/modules/session-agent/types/runtime-migration-adopters.types";
import { buildSessionSpriteLabels } from "../session-sprite-labels.service";
import { logRuntimeMigrationApplyFailure } from
  "./runtime-migration-apply-failure.service";
import { defineContractRuntimeMigration } from "./runtime-migration-definition.service";

export const SESSION_SPRITE_LABELS_RUNTIME_MIGRATION_ID = "sprite.session-labels";

export const sessionSpriteLabelsRuntimeMigration = defineContractRuntimeMigration({
  id: SESSION_SPRITE_LABELS_RUNTIME_MIGRATION_ID,
  description: "Keep the session Sprite label set current",

  buildContext: (dependencies) => ({
    dependencies,
    serverState: dependencies.getServerState(),
    snapshot: dependencies.getEnvironmentSnapshot(),
  }),

  buildContract: ({ serverState, snapshot }): SessionSpriteLabelsContract => {
    if (!serverState.sessionId) {
      throw new Error("Session id is missing");
    }
    return {
      contractSchema: 1,
      labels: buildSessionSpriteLabels(
        serverState.sessionId,
        snapshot.sourceEnvironmentId,
      ),
    };
  },

  apply: async ({ context, desired }) => {
    try {
      await context.dependencies.reconcileSessionSpriteLabels(desired);
      return success(undefined);
    } catch (error) {
      logRuntimeMigrationApplyFailure(
        context.dependencies.logger,
        SESSION_SPRITE_LABELS_RUNTIME_MIGRATION_ID,
        error,
      );
      return failure({
        code: "APPLY_FAILED",
        message: "Session Sprite label apply or verification failed",
        migrationId: SESSION_SPRITE_LABELS_RUNTIME_MIGRATION_ID,
      });
    }
  },
});
