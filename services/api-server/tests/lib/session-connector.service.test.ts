import { failure, success, type Result } from "@repo/shared";
import type {
  CreateCustomApiConnectionRequest,
  SpriteConnectorsClient,
  SpritesConnection,
  SpritesRestError,
} from "@repo/sprites-client";
import { describe, expect, it, vi } from "vitest";
import type { Logger, SessionEnvironmentSnapshot } from "@repo/shared";
import type { Env } from "../../src/shared/types";
import type { ServerState } from "../../src/modules/session-agent/repositories/server-state.repository";
import type {
  SessionConnectorRecord,
  SessionConnectorsRepository,
} from "../../src/modules/session-agent/repositories/session-connectors.repository";
import {
  buildSessionSpriteLabels,
  SessionConnectorService,
} from "../../src/modules/session-agent/services/session-connector.service";

function createLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope() {
      return this;
    },
  };
}

/** Echoes created connectors back through get/list so mint verification passes. */
class FakeSpritesClient implements SpriteConnectorsClient {
  readonly createdRequests: CreateCustomApiConnectionRequest[] = [];
  readonly deletedIds: string[] = [];
  connection: SpritesConnection | null = null;
  createError: SpritesRestError | null = null;
  deleteError: SpritesRestError | null = null;
  private nextConnectionId = 1;

  async createCustomApiConnection(
    request: CreateCustomApiConnectionRequest,
  ): Promise<Result<SpritesConnection, SpritesRestError>> {
    this.createdRequests.push(request);
    if (this.createError) {
      return failure(this.createError);
    }
    this.connection = {
      id: `gateway-conn-${this.nextConnectionId++}`,
      provider: "custom_api",
      providerAccountName: request.name,
      accessPolicy: request.accessPolicy,
    };
    return success(this.connection);
  }

  async listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>> {
    return success(this.connection ? [this.connection] : []);
  }

  async updateAccessPolicy(): Promise<Result<SpritesConnection, SpritesRestError>> {
    throw new Error("Mint must set the final policy during creation.");
  }

  async getConnection(
    connectionId: string,
  ): Promise<Result<SpritesConnection | null, SpritesRestError>> {
    return success(this.connection?.id === connectionId ? this.connection : null);
  }

  async deleteConnection(connectionId: string): Promise<Result<void, SpritesRestError>> {
    this.deletedIds.push(connectionId);
    if (this.deleteError) {
      return failure(this.deleteError);
    }
    if (this.connection?.id === connectionId) {
      this.connection = null;
    }
    return success(undefined);
  }
}

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    sessionId: "session-1",
    userId: "user-1",
    spriteName: "sprite-1",
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    sessionConnectorId: null,
    gitConfiguredViaConnector: false,
    ...overrides,
  };
}

function createEnvironmentSnapshot(
  overrides: Partial<SessionEnvironmentSnapshot> = {},
): SessionEnvironmentSnapshot {
  return {
    sourceEnvironmentId: null,
    sourceEnvironmentName: null,
    repoId: 1,
    network: { mode: "default" },
    plainEnvVars: {},
    startupScript: null,
    resolvedAt: "2026-05-29T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

function createFakeRepository() {
  const rows = new Map<string, SessionConnectorRecord>();
  const repository = {
    rows,
    get: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
    upsertActive: vi.fn(
      async (params: {
        sessionId: string;
        gatewayConnectionId: string;
        connectorName: string;
        policySummary: SessionConnectorRecord["policySummary"];
      }) => {
        rows.set(params.sessionId, {
          sessionId: params.sessionId,
          gatewayConnectionId: params.gatewayConnectionId,
          connectorName: params.connectorName,
          policySummary: params.policySummary,
          status: "active",
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        });
      },
    ),
    markPendingRevocation: vi.fn(async (sessionId: string) => {
      const row = rows.get(sessionId);
      if (row) {
        row.status = "pending_revocation";
      }
    }),
    delete: vi.fn(async (sessionId: string) => {
      rows.delete(sessionId);
    }),
  };
  return repository;
}

function createService(args: {
  serverState?: ServerState;
  spriteLabels?: string[];
  environmentSnapshot?: SessionEnvironmentSnapshot;
} = {}) {
  const serverState = args.serverState ?? createServerState();
  const spritesClient = new FakeSpritesClient();
  const repository = createFakeRepository();
  const updateServerState = vi.fn((partial: Partial<ServerState>) => {
    Object.assign(serverState, partial);
  });
  const updateSpriteLabels = vi.fn(async (_name: string, labels: string[]) => labels);
  const spriteLifecycleClient = {
    getSprite: vi.fn(async () => ({
      name: "sprite-1",
      labels: args.spriteLabels ?? [],
    })),
    updateSpriteLabels,
  };
  const ensureWebhookToken = vi.fn(() => "webhook-token-value");

  const service = new SessionConnectorService({
    logger: createLogger(),
    env: {
      SPRITES_API_KEY: "sprites-key",
      SPRITES_API_URL: "https://api.sprites.test",
      WORKER_URL: "https://worker.test",
    } as Env,
    spriteLifecycleClient: spriteLifecycleClient as never,
    repository: repository as unknown as SessionConnectorsRepository,
    getServerState: () => serverState,
    updateServerState,
    getEnvironmentSnapshot: () =>
      args.environmentSnapshot ?? createEnvironmentSnapshot(),
    ensureWebhookToken,
    spritesClient,
  });

  return {
    service,
    serverState,
    spritesClient,
    repository,
    spriteLifecycleClient,
    updateServerState,
    ensureWebhookToken,
  };
}

describe("buildSessionSpriteLabels", () => {
  it("includes the environment label only when an environment exists", () => {
    expect(buildSessionSpriteLabels("session-1", null)).toEqual(["session:session-1"]);
    expect(buildSessionSpriteLabels("session-1", "environment-1")).toEqual([
      "session:session-1",
      "env:environment-1",
    ]);
  });
});

describe("SessionConnectorService.ensureMinted", () => {
  it("mints a session-labelled connector and persists metadata", async () => {
    const { service, serverState, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });

    await service.ensureMinted("sprite-1");

    expect(spritesClient.createdRequests).toHaveLength(1);
    const created = spritesClient.createdRequests[0]!;
    expect(created.name).toMatch(/^session-session-1-/);
    expect(created.baseApiUrl).toBe("https://worker.test");
    expect(created.accessToken).toBe("webhook-token-value");
    expect(created.testUrl).toBe("https://worker.test/health");
    expect(created.accessPolicy).toEqual({
      allowAll: false,
      spriteLabels: ["session:session-1"],
      allowedEndpoints: [
        "/internal/session/session-1/chunks",
        "/internal/session/session-1/events",
        "/git-proxy/session-1/*",
        "/health",
      ],
    });
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");
    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      status: "active",
    });
  });

  it("repairs missing sprite labels before minting", async () => {
    const { service, spriteLifecycleClient } = createService({
      spriteLabels: [],
      environmentSnapshot: createEnvironmentSnapshot({
        sourceEnvironmentId: "environment-1",
      }),
    });

    await service.ensureMinted("sprite-1");

    expect(spriteLifecycleClient.updateSpriteLabels).toHaveBeenCalledWith("sprite-1", [
      "session:session-1",
      "env:environment-1",
    ]);
  });

  it("still mints when the sprite does not report labels back", async () => {
    // Fly evaluates the label policy at the gateway, so an unreported label
    // must not brick the session; a genuinely unlabelled Sprite simply loses
    // connector access.
    const { service, spriteLifecycleClient, spritesClient } = createService({
      spriteLabels: [],
    });
    spriteLifecycleClient.updateSpriteLabels.mockResolvedValue([]);

    await service.ensureMinted("sprite-1");

    expect(spriteLifecycleClient.updateSpriteLabels).toHaveBeenCalled();
    expect(spritesClient.createdRequests).toHaveLength(1);
  });

  it("is a no-op when the connector checkpoint exists", async () => {
    const { service, spritesClient } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-9" }),
    });

    await service.ensureMinted("sprite-1");

    expect(spritesClient.createdRequests).toHaveLength(0);
  });

  it("deletes an abandoned connector recorded in D1 before minting a new one", async () => {
    const { service, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    await repository.upsertActive({
      sessionId: "session-1",
      gatewayConnectionId: "gateway-conn-stale",
      connectorName: "session-session-1-old",
      policySummary: null,
    });

    await service.ensureMinted("sprite-1");

    expect(spritesClient.deletedIds).toContain("gateway-conn-stale");
    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      status: "active",
    });
  });

  it("throws when minting fails", async () => {
    const { service, serverState, spritesClient } = createService({
      spriteLabels: ["session:session-1"],
    });
    spritesClient.createError = {
      code: "sprites_request_failed",
      message: "boom",
      retryable: false,
    };

    await expect(service.ensureMinted("sprite-1")).rejects.toThrow(
      "Session connector mint failed",
    );
    expect(serverState.sessionConnectorId).toBeNull();
  });

  it("deletes the connector when metadata persistence fails", async () => {
    const { service, serverState, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    repository.upsertActive.mockRejectedValue(new Error("D1 unavailable"));

    await expect(service.ensureMinted("sprite-1")).rejects.toThrow("D1 unavailable");
    expect(spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(serverState.sessionConnectorId).toBeNull();
  });
});

describe("SessionConnectorService.getGatewayBase", () => {
  it("builds the gateway base from the checkpointed connection id", () => {
    const { service } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-7" }),
    });

    expect(service.getGatewayBase()).toBe(
      "https://api.sprites.test/v1/gateway/custom_api/gateway-conn-7",
    );
  });

  it("returns null before a connector is minted", () => {
    const { service } = createService();
    expect(service.getGatewayBase()).toBeNull();
  });
});

describe("SessionConnectorService.deleteForTeardown", () => {
  it("deletes the connector and removes the metadata record", async () => {
    const { service, spritesClient, repository, serverState } = createService({
      spriteLabels: ["session:session-1"],
    });
    await service.ensureMinted("sprite-1");
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");

    await service.deleteForTeardown();

    expect(spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(repository.rows.has("session-1")).toBe(false);
  });

  it("keeps a pending_revocation record when external deletion fails", async () => {
    const { service, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    await service.ensureMinted("sprite-1");
    spritesClient.deleteError = {
      code: "sprites_request_failed",
      message: "boom",
      retryable: true,
    };

    await service.deleteForTeardown();

    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      status: "pending_revocation",
    });
  });

  it("is a no-op without a connector", async () => {
    const { service, spritesClient } = createService();

    await service.deleteForTeardown();

    expect(spritesClient.deletedIds).toHaveLength(0);
  });
});
