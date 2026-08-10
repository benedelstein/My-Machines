import type { Logger } from "@repo/shared";
import {
  buildConnectorGatewayUrl,
  HttpSpriteConnectorsClient,
  type AccessPolicy,
  type CreateCustomApiConnectionRequest,
  type SpritesConnection,
  type SpriteConnectorsClient,
  type SpriteLifecycleClient,
} from "@repo/sprites-client";
import type { Env } from "@/shared/types";
import { deleteConnectorAndVerify, MintConnectorRequestSchema } from
  "@/shared/integrations/sprite-connectors";
import type {
  SessionConnectorAttemptRecord,
  SessionConnectorsRepository,
} from "../repositories/session-connectors.repository";
import type { SessionConnectorContract } from
  "../types/runtime-migration-adopters.types";
import type { ServerState } from
  "../types/server-state.types";

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
  private readonly ensureWebhookToken: () => string;
  private readonly spritesClient: SpriteConnectorsClient;

  constructor(deps: SessionConnectorServiceDeps) {
    this.logger = deps.logger.scope("session-connector-service");
    this.env = deps.env;
    this.spriteLifecycleClient = deps.spriteLifecycleClient;
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

  /** Reconciles connector identity, policy, mirrors, and Sprite labels idempotently. */
  async reconcile(input: {
    contract: SessionConnectorContract;
    desiredRevision: string;
    attempt: number;
  }): Promise<void> {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    const spriteName = serverState.spriteName;
    if (!sessionId || !spriteName) {
      throw new Error("Session connector prerequisites are missing");
    }

    await this.ensureSpriteLabels(spriteName, sessionId, input.contract.requiredSpriteLabels);
    const record = await this.repository.get(sessionId);
    let connectorAttempt = await this.repository.getAttempt(sessionId);
    const desiredPolicy = buildAccessPolicy(sessionId, input.contract);

    if (connectorAttempt && connectorAttempt.desiredRevision !== input.desiredRevision) {
      await this.deleteAttemptConnector(connectorAttempt);
      await this.repository.deleteAttempt(sessionId);
      connectorAttempt = null;
    }

    const candidateIds = [...new Set([
      serverState.sessionConnectorId,
      record?.gatewayConnectionId,
      connectorAttempt?.gatewayConnectionId,
    ].filter((value): value is string => Boolean(value)))];
    for (const connectionId of candidateIds) {
      const connection = await this.getConnection(connectionId);
      if (!connection || !connectorBaseMatches(connection, input.contract.baseApiUrl)) {
        continue;
      }
      const trustedByRecord = record?.gatewayConnectionId === connectionId
        && (record.desiredRevision === null || record.desiredRevision === input.desiredRevision);
      const trustedByAttempt = connectorAttempt?.desiredRevision === input.desiredRevision
        && (connectorAttempt.gatewayConnectionId === connectionId
          || connectorAttempt.connectorName === connection.providerAccountName);
      if (!trustedByRecord && !trustedByAttempt) {
        continue;
      }
      const verified = await this.ensurePolicy(connection, desiredPolicy);
      await this.checkpointVerifiedConnector({
        sessionId,
        connection: verified,
        desiredPolicy,
        desiredRevision: input.desiredRevision,
        attemptIdentity: connectorAttempt?.attemptIdentity ?? record?.attemptIdentity ?? null,
      });
      await this.cleanupPreviousConnector(connectorAttempt, verified.id);
      await this.repository.deleteAttempt(sessionId);
      return;
    }

    if (!connectorAttempt) {
      const attemptIdentity = crypto.randomUUID();
      const connectorName = buildAttemptConnectorName(
        sessionId,
        input.desiredRevision,
        attemptIdentity,
      );
      await this.repository.beginAttempt({
        sessionId,
        desiredRevision: input.desiredRevision,
        attemptIdentity,
        connectorName,
        previousGatewayConnectionId:
          serverState.sessionConnectorId ?? record?.gatewayConnectionId ?? null,
      });
      connectorAttempt = {
        sessionId,
        desiredRevision: input.desiredRevision,
        attemptIdentity,
        connectorName,
        gatewayConnectionId: null,
        previousGatewayConnectionId:
          serverState.sessionConnectorId ?? record?.gatewayConnectionId ?? null,
      };
    }

    const webhookToken = this.ensureWebhookToken();
    const request = MintConnectorRequestSchema.parse({
      name: connectorAttempt.connectorName,
      baseApiUrl: input.contract.baseApiUrl,
      token: webhookToken,
      testUrl: input.contract.testUrl,
      spriteLabels: desiredPolicy.spriteLabels,
      allowedEndpoints: desiredPolicy.allowedEndpoints,
    });
    const connection = await this.createOrDiscoverConnector(
      connectorAttempt.connectorName,
      toCreateRequest(request, desiredPolicy),
    );
    await this.repository.setAttemptConnectionId(sessionId, connection.id);
    const verified = await this.verifyConnection(connection.id, input.contract, desiredPolicy);
    await this.checkpointVerifiedConnector({
      sessionId,
      connection: verified,
      desiredPolicy,
      desiredRevision: input.desiredRevision,
      attemptIdentity: connectorAttempt.attemptIdentity,
    });
    await this.cleanupPreviousConnector(connectorAttempt, verified.id);
    await this.repository.deleteAttempt(sessionId);
  }

  private async createOrDiscoverConnector(
    connectorName: string,
    request: CreateCustomApiConnectionRequest,
  ): Promise<SpritesConnection> {
    const existing = await this.findConnectionByName(connectorName);
    if (existing) {
      return existing;
    }

    const created = await this.spritesClient.createCustomApiConnection(request);
    if (created.ok) {
      return created.value;
    }

    const discovered = await this.findConnectionByName(connectorName);
    if (discovered) {
      return discovered;
    }
    throw new Error(`Session connector create failed: ${created.error.code}`);
  }

  private async findConnectionByName(name: string): Promise<SpritesConnection | null> {
    const listed = await this.spritesClient.listConnections();
    if (!listed.ok) {
      throw new Error(`Session connector list failed: ${listed.error.code}`);
    }
    return listed.value.find((connection) => {
      return connection.provider === "custom_api" && connection.providerAccountName === name;
    }) ?? null;
  }

  private async getConnection(connectionId: string): Promise<SpritesConnection | null> {
    const result = await this.spritesClient.getConnection(connectionId);
    if (!result.ok) {
      throw new Error(`Session connector read failed: ${result.error.code}`);
    }
    return result.value;
  }

  private async verifyConnection(
    connectionId: string,
    contract: SessionConnectorContract,
    policy: AccessPolicy,
  ): Promise<SpritesConnection> {
    const connection = await this.getConnection(connectionId);
    if (!connection || !connectorBaseMatches(connection, contract.baseApiUrl)) {
      throw new Error("Session connector base URL verification failed");
    }
    return this.ensurePolicy(connection, policy);
  }

  private async ensurePolicy(
    connection: SpritesConnection,
    desiredPolicy: AccessPolicy,
  ): Promise<SpritesConnection> {
    if (!policiesMatch(connection.accessPolicy, desiredPolicy)) {
      const updated = await this.spritesClient.updateAccessPolicy(connection.id, desiredPolicy);
      if (!updated.ok) {
        throw new Error(`Session connector policy update failed: ${updated.error.code}`);
      }
    }
    const readback = await this.getConnection(connection.id);
    if (!readback || !policiesMatch(readback.accessPolicy, desiredPolicy)) {
      throw new Error("Session connector policy readback did not match");
    }
    return readback;
  }

  private async checkpointVerifiedConnector(input: {
    sessionId: string;
    connection: SpritesConnection;
    desiredPolicy: AccessPolicy;
    desiredRevision: string;
    attemptIdentity: string | null;
  }): Promise<void> {
    await this.repository.upsertActive({
      sessionId: input.sessionId,
      gatewayConnectionId: input.connection.id,
      connectorName: input.connection.providerAccountName ?? `session-${input.sessionId}`,
      policySummary: input.desiredPolicy,
      desiredRevision: input.desiredRevision,
      attemptIdentity: input.attemptIdentity,
    });
    this.updateServerState({
      sessionConnectorId: input.connection.id,
      spriteLabelsApplied: true,
    });
  }

  private async cleanupPreviousConnector(
    attempt: SessionConnectorAttemptRecord | null,
    activeConnectionId: string,
  ): Promise<void> {
    const previousConnectionId = attempt?.previousGatewayConnectionId;
    if (!previousConnectionId || previousConnectionId === activeConnectionId) {
      return;
    }
    const cleanup = await deleteConnectorAndVerify(previousConnectionId, this.spritesClient);
    if (!cleanup.ok) {
      throw new Error(`Previous session connector cleanup failed: ${cleanup.error.cause}`);
    }
  }

  private async deleteAttemptConnector(attempt: SessionConnectorAttemptRecord): Promise<void> {
    const connection = attempt.gatewayConnectionId
      ? await this.getConnection(attempt.gatewayConnectionId)
      : await this.findConnectionByName(attempt.connectorName);
    if (!connection) {
      return;
    }
    const cleanup = await deleteConnectorAndVerify(connection.id, this.spritesClient);
    if (!cleanup.ok) {
      throw new Error(`Abandoned session connector cleanup failed: ${cleanup.error.cause}`);
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
   * connector is minted, repairing Sprites created before label support. Skips
   * the read-back entirely when creation already applied the labels. Fly
   * enforces the label policy at the gateway, so a missing label costs the
   * Sprite connector access rather than granting any.
   */
  private async ensureSpriteLabels(
    spriteName: string,
    sessionId: string,
    desired: readonly string[],
  ): Promise<void> {
    if (this.getServerState().spriteLabelsApplied) {
      return;
    }
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
      throw new Error(
        `Sprite label update did not persist required labels: ${missing.join(", ")}`,
      );
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

function buildAttemptConnectorName(
  sessionId: string,
  desiredRevision: string,
  attemptIdentity: string,
): string {
  return `session-${sessionId}-${desiredRevision.slice(0, 10)}-${attemptIdentity.slice(0, 8)}`
    .slice(0, 100);
}

function connectorBaseMatches(connection: SpritesConnection, baseApiUrl: string): boolean {
  const reportedBaseUrl = connection.providerInfo?.base_api_url;
  return connection.provider === "custom_api"
    && typeof reportedBaseUrl === "string"
    && normalizeUrl(reportedBaseUrl) === normalizeUrl(baseApiUrl);
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

function toCreateRequest(
  request: ReturnType<typeof MintConnectorRequestSchema.parse>,
  accessPolicy: AccessPolicy,
): CreateCustomApiConnectionRequest {
  return {
    name: request.name,
    baseApiUrl: request.baseApiUrl,
    accessToken: request.token,
    testUrl: request.testUrl,
    authHeaderPrefix: request.headerPrefix,
    description: "Provisioned by My Machines",
    accessPolicy,
  };
}
