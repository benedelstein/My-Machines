import type { Logger } from "@repo/shared";
import {
  buildConnectorGatewayUrl,
  HttpSpriteConnectorsClient,
  type AccessPolicy,
  type SpriteConnector,
  type SpriteConnectorsClient,
} from "@repo/sprites-client";
import type { Env } from "@/shared/types";
import { ConnectorProvisioningRequestSchema, deleteConnectorAndVerify } from
  "@/shared/integrations/sprite-connectors";
import type { SessionConnectorsRepository } from
  "../repositories/session-connectors.repository";
import type { SessionConnectorContract } from
  "../types/runtime-migration-adopters.types";
import type { ServerState } from
  "../types/server-state.types";

export interface SessionConnectorServiceDeps {
  logger: Logger;
  env: Env;
  repository: SessionConnectorsRepository;
  getServerState: () => ServerState;
  updateServerState: (partial: Partial<ServerState>) => void;
  ensureWebhookToken: () => string;
  /** Test seam; defaults to an HTTP client against SPRITES_API_URL. */
  spritesClient?: SpriteConnectorsClient;
}

/**
 * Owns the session's internal Sprites connector: label-scoped minting during
 * provisioning, gateway base resolution for class-A clients, and fail-closed
 * teardown. The injected credential is the DO's existing webhook token, which
 * never leaves DO SQLite except into Sprites custody at mint time.
 */
export class SessionConnectorService {
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly repository: SessionConnectorsRepository;
  private readonly getServerState: () => ServerState;
  private readonly updateServerState: SessionConnectorServiceDeps["updateServerState"];
  private readonly ensureWebhookToken: () => string;
  private readonly spritesClient: SpriteConnectorsClient;

  constructor(deps: SessionConnectorServiceDeps) {
    this.logger = deps.logger.scope("session-connector-service");
    this.env = deps.env;
    this.repository = deps.repository;
    this.getServerState = deps.getServerState;
    this.updateServerState = deps.updateServerState;
    this.ensureWebhookToken = deps.ensureWebhookToken;
    this.spritesClient =
      deps.spritesClient ??
      new HttpSpriteConnectorsClient({
        apiUrl: this.env.SPRITES_API_URL,
        apiToken: this.env.SPRITES_API_KEY,
      });
  }

  /** Reconciles connector identity, policy, and mirrors idempotently. */
  async reconcile(input: {
    contract: SessionConnectorContract;
  }): Promise<void> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    if (!sessionId || !serverState.spriteName) {
      throw new Error("Session connector prerequisites are missing");
    }

    const record = await this.repository.get(sessionId);
    const desiredPolicy = buildAccessPolicy(sessionId, input.contract);
    const knownIds = [...new Set([
      serverState.sessionConnectorId,
      record?.status === "active" ? record.gatewayConnectorId : null,
    ].filter((value): value is string => Boolean(value)))];
    const compatibleConnectors: SpriteConnector[] = [];
    for (const connectorId of knownIds) {
      const connector = await this.getConnector(connectorId);
      // if the structure doesn't match, we need to create a new connector.
      if (connector && connectorStructureMatches(connector, input.contract)) {
        compatibleConnectors.push(connector);
      }
    }

    const preferred = compatibleConnectors.find((connector) =>
      connector.id === serverState.sessionConnectorId)
      ?? compatibleConnectors[0];
    const verified = preferred
      ? await this.ensurePolicy(preferred, input.contract, desiredPolicy)
      : await this.createAndVerifyConnector(sessionId, input.contract, desiredPolicy);

    await this.cleanupOtherKnownConnectors(knownIds, verified.id);
    await this.checkpointVerifiedConnector({
      sessionId,
      connector: verified,
      desiredPolicy,
    });
  }

  private async createAndVerifyConnector(
    sessionId: string,
    contract: SessionConnectorContract,
    desiredPolicy: AccessPolicy,
  ): Promise<SpriteConnector> {
    const request = ConnectorProvisioningRequestSchema.parse({
      name: buildConnectorName(sessionId),
      baseApiUrl: contract.baseApiUrl,
      accessToken: this.ensureWebhookToken(),
      testUrl: contract.testUrl,
      authHeaderPrefix: "Bearer",
      accessPolicy: desiredPolicy,
    });
    const created = await this.spritesClient.createCustomApiConnector(request);
    if (!created.ok) {
      throw new Error(`Session connector create failed: ${created.error.code}`);
    }
    try {
      // Create responses may omit policy or provider details; read back the
      // complete connector before checkpointing security-sensitive state.
      return await this.verifyConnector(created.value.id, contract, desiredPolicy);
    } catch (error) {
      const cleanup = await deleteConnectorAndVerify(created.value.id, this.spritesClient);
      if (!cleanup.ok) {
        throw new Error(
          `Unverified session connector cleanup failed: ${cleanup.error.cause}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async getConnector(connectorId: string): Promise<SpriteConnector | null> {
    const result = await this.spritesClient.getConnector(connectorId);
    if (!result.ok) {
      throw new Error(`Session connector read failed: ${result.error.code}`);
    }
    return result.value;
  }

  private async verifyConnector(
    connectorId: string,
    contract: SessionConnectorContract,
    policy: AccessPolicy,
  ): Promise<SpriteConnector> {
    const connector = await this.getConnector(connectorId);
    if (!connector
      || !connectorStructureMatches(connector, contract)
      || !policiesMatch(connector.accessPolicy, policy)) {
      throw new Error("Session connector create verification failed");
    }
    return connector;
  }

  private async ensurePolicy(
    connector: SpriteConnector,
    contract: SessionConnectorContract,
    desiredPolicy: AccessPolicy,
  ): Promise<SpriteConnector> {
    if (policiesMatch(connector.accessPolicy, desiredPolicy)) {
      return connector;
    }
    const updated = await this.spritesClient.updateAccessPolicy(connector.id, desiredPolicy);
    if (!updated.ok) {
      throw new Error(`Session connector policy update failed: ${updated.error.code}`);
    }
    if (updated.value.id !== connector.id
      || !connectorStructureMatches(updated.value, contract)
      || !policiesMatch(updated.value.accessPolicy, desiredPolicy)) {
      throw new Error("Session connector policy update response did not match desired state");
    }
    return updated.value;
  }

  private async checkpointVerifiedConnector(input: {
    sessionId: string;
    connector: SpriteConnector;
    desiredPolicy: AccessPolicy;
  }): Promise<void> {
    await this.repository.upsertActive({
      sessionId: input.sessionId,
      gatewayConnectorId: input.connector.id,
      connectorName: input.connector.providerAccountName ?? `session-${input.sessionId}`,
      policySummary: input.desiredPolicy,
    });
    this.updateServerState({ sessionConnectorId: input.connector.id });
  }

  private async cleanupOtherKnownConnectors(
    knownIds: readonly string[],
    selectedConnectorId: string,
  ): Promise<void> {
    for (const connectorId of knownIds) {
      if (connectorId === selectedConnectorId) {
        continue;
      }
      const cleanup = await deleteConnectorAndVerify(connectorId, this.spritesClient);
      if (!cleanup.ok) {
        throw new Error(`Previous session connector cleanup failed: ${cleanup.error.cause}`);
      }
    }
  }

  /**
   * Returns the session's connector gateway base URL, or null when no
   * connector has been minted for this session.
   */
  getGatewayBase(): string | null {
    const connectorId = this.getServerState().sessionConnectorId;
    if (!connectorId) {
      return null;
    }
    return buildConnectorGatewayUrl(this.env.SPRITES_API_URL, connectorId);
  }

  /**
   * Deletes the session's connector at teardown. Never throws: teardown must
   * continue to Sprite deletion, so failures are logged and the D1 record is
   * kept in pending_revocation with the gateway connector id for later
   * reconciliation.
   */
  async deleteForTeardown(): Promise<void> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    if (!sessionId) {
      return;
    }

    let gatewayConnectorId = serverState.sessionConnectorId;
    try {
      const record = await this.repository.get(sessionId);
      gatewayConnectorId = record?.gatewayConnectorId ?? gatewayConnectorId;
      if (!gatewayConnectorId) {
        return;
      }
      await this.repository.markPendingRevocation(sessionId);
      const cleanup = await deleteConnectorAndVerify(
        gatewayConnectorId,
        this.spritesClient,
      );
      if (!cleanup.ok) {
        this.logger.error("Session connector teardown delete failed", {
          fields: {
            sessionId,
            gatewayConnectorId,
            cause: cleanup.error.cause,
            retryable: cleanup.error.retryable,
          },
        });
        return;
      }
      await this.repository.delete(sessionId);
      this.logger.info("Session connector deleted", {
        fields: { sessionId, gatewayConnectorId },
      });
    } catch (error) {
      this.logger.error("Session connector teardown errored", {
        fields: { sessionId, gatewayConnectorId },
        error,
      });
    }
  }

}

function buildAccessPolicy(
  sessionId: string,
  contract: SessionConnectorContract,
): AccessPolicy {
  return {
    allowAll: false,
    spriteLabels: [`session:${sessionId}`],
    allowedEndpoints: [...contract.accessPolicy.allowedEndpoints],
    blockedEndpoints: [...contract.accessPolicy.blockedEndpoints],
  };
}

function buildConnectorName(sessionId: string): string {
  return `session-${sessionId}-${crypto.randomUUID().slice(0, 8)}`
    .slice(0, 100);
}

function connectorStructureMatches(
  connector: SpriteConnector,
  contract: SessionConnectorContract,
): boolean {
  const reportedBaseUrl = connector.providerInfo?.base_api_url;
  const reportedTestUrl = connector.providerInfo?.test_url;
  return connector.provider === contract.provider
    && typeof reportedBaseUrl === "string"
    && normalizeUrl(reportedBaseUrl) === normalizeUrl(contract.baseApiUrl)
    && typeof reportedTestUrl === "string"
    && reportedTestUrl === contract.testUrl;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function policiesMatch(actual: AccessPolicy | undefined, expected: AccessPolicy): boolean {
  return actual?.allowAll === expected.allowAll
    && actual.namePrefix === expected.namePrefix
    && arraysEqual(actual.spriteLabels, expected.spriteLabels)
    && arraysEqual(actual.allowedEndpoints ?? [], expected.allowedEndpoints ?? [])
    && arraysEqual(actual.blockedEndpoints ?? [], expected.blockedEndpoints ?? []);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}
