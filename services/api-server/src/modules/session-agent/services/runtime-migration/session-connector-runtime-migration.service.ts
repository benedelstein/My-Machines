import { failure, success } from "@repo/shared";
import type { SessionConnectorContract } from
  "@/modules/session-agent/types/runtime-migration-adopters.types";
import { buildSessionSpriteLabels } from "../session-connector.service";
import { defineContractRuntimeMigration } from "./runtime-migration-definition.service";

export const SESSION_CONNECTOR_RUNTIME_MIGRATION_ID = "session.connector-resource";

const connectorEndpoints = (sessionId: string): string[] => [
  `/internal/session/${sessionId}/chunks`,
  `/internal/session/${sessionId}/events`,
  `/internal/session/${sessionId}/git-token`,
  "/health",
];

export const sessionConnectorRuntimeMigration = defineContractRuntimeMigration({
  id: SESSION_CONNECTOR_RUNTIME_MIGRATION_ID,
  description: "Keep the session connector and access policy current",

  buildContext: (dependencies) => ({
    dependencies,
    serverState: dependencies.getServerState(),
    snapshot: dependencies.getEnvironmentSnapshot(),
  }),

  buildContract: ({ dependencies, serverState, snapshot }): SessionConnectorContract => {
    if (!serverState.sessionId) {
      throw new Error("Session id is missing");
    }
    const workerUrl = dependencies.env.WORKER_URL.replace(/\/+$/u, "");
    return {
      contractSchema: 1,
      provider: "custom_api",
      baseApiUrl: workerUrl,
      testUrl: `${workerUrl}/health`,
      requiredSpriteLabels: buildSessionSpriteLabels(
        serverState.sessionId,
        snapshot.sourceEnvironmentId,
      ),
      accessPolicy: {
        allowedEndpoints: connectorEndpoints(serverState.sessionId),
        blockedEndpoints: [],
      },
    };
  },

  apply: async ({ context, desired, revision, attempt }) => {
    if (revision.kind !== "contract") {
      return failure({
        code: "MIGRATION_REVISION_KIND_CHANGED",
        message: "Session connector migration revision kind changed",
        migrationId: SESSION_CONNECTOR_RUNTIME_MIGRATION_ID,
      });
    }
    try {
      await context.dependencies.reconcileSessionConnector({
        contract: desired,
        desiredRevision: revision.hash,
        attempt,
      });
      return success(undefined);
    } catch {
      return failure({
        code: "APPLY_FAILED",
        message: "Session connector apply or verification failed",
        migrationId: SESSION_CONNECTOR_RUNTIME_MIGRATION_ID,
      });
    }
  },
});
