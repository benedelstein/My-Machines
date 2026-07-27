import type { Logger, SessionEnvironmentSnapshot } from "@repo/shared";
import {
  buildConnectorGatewayUrl,
  HttpSpriteConnectorsClient,
  type SpriteConnectorsClient,
  type SpriteLifecycleClient,
} from "@repo/sprites-client";
import type { Env } from "@/shared/types";
import {
  deleteConnectorAndVerify,
  mintConnector,
  MintConnectorRequestSchema,
} from "@/shared/integrations/sprite-connectors";
import type { CleanupStatus } from "@/shared/integrations/sprite-connectors";
import type { SessionConnectorsRepository } from "../repositories/session-connectors.repository";
import type { ServerState } from "../repositories/server-state.repository";

/**
 * Builds the Sprite labels a session's VM must carry: the unique session
 * label the internal connector's access policy binds to, plus the source
 * environment label when the session was created from an environment.
 *
 * @param sessionId - The session id (also the Sprite name).
 * @param sourceEnvironmentId - The session's source environment id, if any.
 * @returns The full label set for the session's Sprite.
 */
export function buildSessionSpriteLabels(
  sessionId: string,
  sourceEnvironmentId: string | null,
): string[] {
  const labels = [`session:${sessionId}`];
  if (sourceEnvironmentId) {
    labels.push(`env:${sourceEnvironmentId}`);
  }
  return labels;
}

export interface SessionConnectorServiceDeps {
  logger: Logger;
  env: Env;
  spriteLifecycleClient: SpriteLifecycleClient;
  repository: SessionConnectorsRepository;
  getServerState: () => ServerState;
  updateServerState: (partial: Partial<ServerState>) => void;
  getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
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
  private readonly spriteLifecycleClient: SpriteLifecycleClient;
  private readonly repository: SessionConnectorsRepository;
  private readonly getServerState: () => ServerState;
  private readonly updateServerState: SessionConnectorServiceDeps["updateServerState"];
  private readonly getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  private readonly ensureWebhookToken: () => string;
  private readonly spritesClient: SpriteConnectorsClient;

  constructor(deps: SessionConnectorServiceDeps) {
    this.logger = deps.logger.scope("session-connector-service");
    this.env = deps.env;
    this.spriteLifecycleClient = deps.spriteLifecycleClient;
    this.repository = deps.repository;
    this.getServerState = deps.getServerState;
    this.updateServerState = deps.updateServerState;
    this.getEnvironmentSnapshot = deps.getEnvironmentSnapshot;
    this.ensureWebhookToken = deps.ensureWebhookToken;
    this.spritesClient =
      deps.spritesClient ??
      new HttpSpriteConnectorsClient({
        apiUrl: this.env.SPRITES_API_URL,
        apiToken: this.env.SPRITES_API_KEY,
      });
  }

  /**
   * Ensures the session's internal connector exists: verifies the Sprite
   * carries the session labels (repairing pre-label Sprites), mints the
   * connector with the final session-label policy and endpoint pins, persists
   * metadata to D1, and checkpoints the gateway connection id in ServerState.
   * Throws on any failure so the setup task fails closed and stays retryable.
   */
  async ensureMinted(spriteName: string): Promise<void> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    if (!sessionId) {
      throw new Error("Session id is missing");
    }
    if (serverState.sessionConnectorId) {
      return;
    }

    await this.ensureSpriteLabels(spriteName, sessionId);
    await this.reconcileAbandonedConnector(sessionId);

    const webhookToken = this.ensureWebhookToken();
    const request = MintConnectorRequestSchema.parse({
      name: `session-${sessionId}`,
      baseApiUrl: this.env.WORKER_URL,
      token: webhookToken,
      testUrl: `${this.env.WORKER_URL}/health`,
      spriteLabels: [`session:${sessionId}`],
      allowedEndpoints: [
        `/internal/session/${sessionId}/chunks`,
        `/internal/session/${sessionId}/events`,
        `/git-proxy/${sessionId}/*`,
        "/health",
      ],
    });

    const mintResult = await mintConnector(request, {
      spritesClient: this.spritesClient,
    });
    if (!mintResult.ok) {
      const mintError = mintResult.error;
      this.logger.error("Session connector mint failed", {
        fields: {
          sessionId,
          code: mintError.code,
          stage: mintError.stage,
          retryable: mintError.retryable,
          orphanConnectorId: orphanConnectorId(mintError.cleanup),
          totalMs: mintError.durations.totalMs,
        },
      });
      throw new Error(
        `Session connector mint failed: ${mintError.code} at ${mintError.stage}`,
      );
    }

    const minted = mintResult.value;
    try {
      await this.repository.upsertActive({
        sessionId,
        gatewayConnectionId: minted.gatewayConnectionId,
        connectorName: minted.name,
        policySummary: minted.accessPolicy,
      });
    } catch (error) {
      // Fail closed: without persisted metadata the connector could never be
      // reconciled, so delete it before surfacing the failure.
      const cleanup = await deleteConnectorAndVerify(
        minted.gatewayConnectionId,
        this.spritesClient,
      );
      this.logger.error("Session connector metadata persist failed", {
        fields: {
          sessionId,
          gatewayConnectionId: minted.gatewayConnectionId,
          cleanupSucceeded: cleanup.ok,
        },
        error,
      });
      throw error instanceof Error
        ? error
        : new Error("Session connector metadata persist failed");
    }

    this.updateServerState({ sessionConnectorId: minted.gatewayConnectionId });
    this.logger.info("Session connector minted", {
      fields: {
        sessionId,
        gatewayConnectionId: minted.gatewayConnectionId,
        connectorName: minted.name,
        totalMs: minted.durations.totalMs,
      },
    });
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
   * kept in pending_revocation with the gateway connection id for later
   * reconciliation.
   */
  async deleteForTeardown(): Promise<void> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    if (!sessionId) {
      return;
    }

    let gatewayConnectionId = serverState.sessionConnectorId;
    try {
      const record = await this.repository.get(sessionId);
      gatewayConnectionId = record?.gatewayConnectionId ?? gatewayConnectionId;
      if (!gatewayConnectionId) {
        return;
      }
      await this.repository.markPendingRevocation(sessionId);
      const cleanup = await deleteConnectorAndVerify(
        gatewayConnectionId,
        this.spritesClient,
      );
      if (!cleanup.ok) {
        this.logger.error("Session connector teardown delete failed", {
          fields: {
            sessionId,
            gatewayConnectionId,
            cause: cleanup.error.cause,
            retryable: cleanup.error.retryable,
          },
        });
        return;
      }
      await this.repository.delete(sessionId);
      this.logger.info("Session connector deleted", {
        fields: { sessionId, gatewayConnectionId },
      });
    } catch (error) {
      this.logger.error("Session connector teardown errored", {
        fields: { sessionId, gatewayConnectionId },
        error,
      });
    }
  }

  /**
   * Ensures the Sprite carries the session (and environment) labels before the
   * connector is minted, repairing Sprites created before label support.
   *
   * The read-back is a diagnostic, not the security boundary: Fly evaluates the
   * label policy at the gateway before injecting the credential, so a Sprite
   * that is genuinely unlabelled loses connector access rather than gaining
   * any. The Sprites client also cannot distinguish "no labels" from "labels
   * not reported", so a missing read-back is logged instead of failing the
   * session.
   */
  private async ensureSpriteLabels(
    spriteName: string,
    sessionId: string,
  ): Promise<void> {
    const snapshot = this.getEnvironmentSnapshot();
    const desired = buildSessionSpriteLabels(
      sessionId,
      snapshot.sourceEnvironmentId,
    );
    const sprite = await this.spriteLifecycleClient.getSprite(spriteName);
    const existing = sprite.labels ?? [];
    if (desired.every((label) => existing.includes(label))) {
      return;
    }

    const merged = [...new Set([...existing, ...desired])];
    const updated = await this.spriteLifecycleClient.updateSpriteLabels(
      spriteName,
      merged,
    );
    const missing = desired.filter((label) => !updated.includes(label));
    if (missing.length > 0) {
      this.logger.warn("Sprite labels missing after update", {
        fields: { sessionId, spriteName, missing, reported: updated },
      });
    }
  }

  /**
   * Deletes a connector recorded in D1 that ServerState no longer references,
   * which can only happen when a prior mint crashed between the D1 write and
   * the ServerState checkpoint. Keeps exactly one connector per session.
   */
  private async reconcileAbandonedConnector(sessionId: string): Promise<void> {
    const record = await this.repository.get(sessionId);
    if (!record) {
      return;
    }
    const cleanup = await deleteConnectorAndVerify(
      record.gatewayConnectionId,
      this.spritesClient,
    );
    if (!cleanup.ok) {
      await this.repository.markPendingRevocation(sessionId);
      throw new Error(
        `Abandoned session connector cleanup failed: ${cleanup.error.cause}`,
      );
    }
    await this.repository.delete(sessionId);
    this.logger.warn("Reconciled abandoned session connector", {
      fields: { sessionId, gatewayConnectionId: record.gatewayConnectionId },
    });
  }
}

function orphanConnectorId(cleanup: CleanupStatus): string | null {
  return cleanup.attempted && !cleanup.succeeded
    ? cleanup.gatewayConnectionId
    : null;
}
