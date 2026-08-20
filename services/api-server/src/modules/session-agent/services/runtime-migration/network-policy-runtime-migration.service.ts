import { failure, success } from "@repo/shared";
import { buildFinalNetworkPolicy } from "@repo/sprites-client";
import type { SpriteNetworkPolicyContract } from
  "@/modules/session-agent/types/runtime-migration-adopters.types";
import { logRuntimeMigrationApplyFailure } from
  "./runtime-migration-apply-failure.service";
import { defineContractRuntimeMigration } from "./runtime-migration-definition.service";

export const NETWORK_POLICY_RUNTIME_MIGRATION_ID = "sprite.network-policy";

export const networkPolicyRuntimeMigration = defineContractRuntimeMigration({
  id: NETWORK_POLICY_RUNTIME_MIGRATION_ID,
  description: "Keep the Sprite network policy at its snapshotted value",

  buildContext: (dependencies) => ({
    dependencies,
    providerId: dependencies.getClientState().agentSettings.provider,
    snapshot: dependencies.getEnvironmentSnapshot(),
  }),

  buildContract: ({ dependencies, providerId, snapshot }): SpriteNetworkPolicyContract => {
    const workerHostname = new URL(dependencies.env.WORKER_URL).hostname;
    const connectorGatewayHostname = new URL(dependencies.env.SPRITES_API_URL).hostname;
    return {
      contractSchema: 1,
      providerId,
      requestedNetwork: snapshot.network,
      workerHostname,
      connectorGatewayHostname,
      rules: buildFinalNetworkPolicy({
        workerHostname,
        providerId,
        network: snapshot.network,
        connectorGatewayHostname,
      }),
    };
  },

  apply: async ({ context, desired }) => {
    try {
      const sprite = context.dependencies.createSpriteClient();
      const desiredRules = desired.rules.map((rule) => ({ ...rule }));
      await sprite.setNetworkPolicy(desiredRules);
      context.dependencies.updateServerState({ finalNetworkPolicyApplied: true });
      return success(undefined);
    } catch (error) {
      logRuntimeMigrationApplyFailure(
        context.dependencies.logger,
        NETWORK_POLICY_RUNTIME_MIGRATION_ID,
        error,
      );
      return failure({
        code: "APPLY_FAILED",
        message: "Sprite network policy apply failed",
        migrationId: NETWORK_POLICY_RUNTIME_MIGRATION_ID,
      });
    }
  },
});
