import { failure, success, type Result } from "@repo/shared";
import type {
  CreateCustomApiConnectionRequest,
  SpriteConnectorsClient,
  SpritesConnection,
  SpritesRestError,
} from "@repo/sprites-client";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "./test-logger";
import type { SessionEnvironmentSnapshot } from "@repo/shared";
import type { Env } from "../../src/shared/types";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import type {
  SessionConnectorAttemptRecord,
  SessionConnectorRecord,
  SessionConnectorsRepository,
} from "../../src/modules/session-agent/repositories/session-connectors.repository";
import type { SessionConnectorContract } from
  "../../src/modules/session-agent/types/runtime-migration-adopters.types";
import {
  buildSessionSpriteLabels,
  SessionConnectorService,
} from "../../src/modules/session-agent/services/session-connector.service";

/** Echoes created connectors back through get/list so mint verification passes. */
class FakeSpritesClient implements SpriteConnectorsClient {
  readonly createdRequests: CreateCustomApiConnectionRequest[] = [];
  readonly deletedIds: string[] = [];
  connection: SpritesConnection | null = null;
  createError: SpritesRestError | null = null;
  createBeforeError = false;
  deleteError: SpritesRestError | null = null;
  private nextConnectionId = 1;

  async createCustomApiConnection(
    request: CreateCustomApiConnectionRequest,
  ): Promise<Result<SpritesConnection, SpritesRestError>> {
    this.createdRequests.push(request);
    if (this.createError) {
      if (this.createBeforeError) {
        this.connection = {
          id: `gateway-conn-${this.nextConnectionId++}`,
          provider: "custom_api",
          providerAccountName: request.name,
          providerInfo: { base_api_url: request.baseApiUrl },
          accessPolicy: request.accessPolicy,
        };
      }
      return failure(this.createError);
    }
    this.connection = {
      id: `gateway-conn-${this.nextConnectionId++}`,
      provider: "custom_api",
      providerAccountName: request.name,
      providerInfo: {
        base_api_url: request.baseApiUrl,
        test_url: request.testUrl,
      },
      accessPolicy: request.accessPolicy,
    };
    return success(this.connection);
  }

  async listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>> {
    return success(this.connection ? [this.connection] : []);
  }

  async updateAccessPolicy(
    connectionId: string,
    accessPolicy: CreateCustomApiConnectionRequest["accessPolicy"],
  ): Promise<Result<SpritesConnection, SpritesRestError>> {
    if (!this.connection || this.connection.id !== connectionId) {
      return failure({ code: "sprites_request_failed", retryable: false });
    }
    this.connection = { ...this.connection, accessPolicy };
    return success(this.connection);
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
    spriteLabelsApplied: false,
    gitAuthMode: "legacy_secret",
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
  const attempts = new Map<string, SessionConnectorAttemptRecord>();
  const repository = {
    rows,
    attempts,
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
          desiredRevision: params.desiredRevision ?? null,
          attemptIdentity: params.attemptIdentity ?? null,
          status: "active",
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        });
      },
    ),
    getAttempt: vi.fn(async (sessionId: string) => attempts.get(sessionId) ?? null),
    beginAttempt: vi.fn(async (params: SessionConnectorAttemptRecord) => {
      attempts.set(params.sessionId, { ...params, gatewayConnectionId: null });
    }),
    setAttemptConnectionId: vi.fn(async (sessionId: string, gatewayConnectionId: string) => {
      const attempt = attempts.get(sessionId);
      if (attempt) {
        attempts.set(sessionId, { ...attempt, gatewayConnectionId });
      }
    }),
    deleteAttempt: vi.fn(async (sessionId: string) => {
      attempts.delete(sessionId);
    }),
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
  const setSessionConnectorId = vi.fn((gatewayConnectionId: string) => {
    serverState.sessionConnectorId = gatewayConnectionId;
  });
  const updateServerState = vi.fn((partial: Partial<ServerState>) => {
    Object.assign(serverState, partial);
    if (partial.sessionConnectorId) {
      setSessionConnectorId(partial.sessionConnectorId);
    }
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
    logger: createTestLogger(),
    env: {
      SPRITES_API_KEY: "sprites-key",
      SPRITES_API_URL: "https://api.sprites.test",
      WORKER_URL: "https://worker.test",
    } as Env,
    spriteLifecycleClient: spriteLifecycleClient as never,
    repository: repository as unknown as SessionConnectorsRepository,
    getServerState: () => serverState,
    updateServerState,
    ensureWebhookToken,
    spritesClient,
  });

  return {
    service,
    serverState,
    spritesClient,
    repository,
    spriteLifecycleClient,
    setSessionConnectorId,
    ensureWebhookToken,
  };
}

function createConnectorContract(
  snapshot: SessionEnvironmentSnapshot = createEnvironmentSnapshot(),
): SessionConnectorContract {
  return {
    contractSchema: 1,
    provider: "custom_api",
    baseApiUrl: "https://worker.test",
    testUrl: "https://worker.test/health",
    requiredSpriteLabels: buildSessionSpriteLabels(
      "session-1",
      snapshot.sourceEnvironmentId,
    ),
    accessPolicy: {
      allowedEndpoints: [
        "/internal/session/session-1/chunks",
        "/internal/session/session-1/events",
        "/internal/session/session-1/git-token",
        "/health",
      ],
      blockedEndpoints: [],
    },
  };
}

async function reconcileConnector(
  service: SessionConnectorService,
  contract = createConnectorContract(),
): Promise<void> {
  await service.reconcile({
    contract,
    desiredRevision: "a".repeat(64),
  });
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

describe("SessionConnectorService.reconcile", () => {
  it("mints a session-labelled connector and persists metadata", async () => {
    const { service, serverState, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });

    await reconcileConnector(service);

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
        "/internal/session/session-1/git-token",
        "/health",
      ],
      blockedEndpoints: [],
    });
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");
    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      status: "active",
    });
  });

  it("skips the label read-back when creation already applied the labels", async () => {
    const { service, spriteLifecycleClient, spritesClient } = createService({
      serverState: createServerState({ spriteLabelsApplied: true }),
    });

    await reconcileConnector(service);

    expect(spriteLifecycleClient.getSprite).not.toHaveBeenCalled();
    expect(spriteLifecycleClient.updateSpriteLabels).not.toHaveBeenCalled();
    expect(spritesClient.createdRequests).toHaveLength(1);
  });

  it("repairs missing sprite labels before minting", async () => {
    const { service, spriteLifecycleClient } = createService({
      spriteLabels: [],
      environmentSnapshot: createEnvironmentSnapshot({
        sourceEnvironmentId: "environment-1",
      }),
    });

    await reconcileConnector(
      service,
      createConnectorContract(createEnvironmentSnapshot({
        sourceEnvironmentId: "environment-1",
      })),
    );

    expect(spriteLifecycleClient.updateSpriteLabels).toHaveBeenCalledWith("sprite-1", [
      "session:session-1",
      "env:environment-1",
    ]);
  });

  it("fails closed when the sprite does not report required labels back", async () => {
    const { service, spriteLifecycleClient, spritesClient } = createService({
      spriteLabels: [],
    });
    spriteLifecycleClient.updateSpriteLabels.mockResolvedValue([]);

    await expect(reconcileConnector(service)).rejects.toThrow(
      "Sprite label update did not persist required labels: session:session-1",
    );

    expect(spriteLifecycleClient.updateSpriteLabels).toHaveBeenCalled();
    expect(spritesClient.createdRequests).toHaveLength(0);
  });

  it("adopts a verified legacy connector checkpoint without creating", async () => {
    const { service, spritesClient, repository } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-9" }),
      spriteLabels: ["session:session-1"],
    });
    spritesClient.connection = {
      id: "gateway-conn-9",
      provider: "custom_api",
      providerAccountName: "session-session-1-legacy",
      providerInfo: { base_api_url: "https://worker.test" },
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: createConnectorContract().accessPolicy.allowedEndpoints,
        blockedEndpoints: [],
      },
    };
    await repository.upsertActive({
      sessionId: "session-1",
      gatewayConnectionId: "gateway-conn-9",
      connectorName: "session-session-1-legacy",
      policySummary: spritesClient.connection.accessPolicy,
    });

    await reconcileConnector(service);

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

    await reconcileConnector(service);

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

    await expect(reconcileConnector(service)).rejects.toThrow(
      "Session connector create failed",
    );
    expect(serverState.sessionConnectorId).toBeNull();
  });

  it("retains attempt provenance when active metadata persistence fails", async () => {
    const { service, serverState, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    repository.upsertActive.mockRejectedValue(new Error("D1 unavailable"));

    await expect(reconcileConnector(service)).rejects.toThrow("D1 unavailable");
    expect(repository.attempts.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      desiredRevision: "a".repeat(64),
    });
    expect(spritesClient.deletedIds).not.toContain("gateway-conn-1");
    expect(serverState.sessionConnectorId).toBeNull();
  });

  it("updates and reads back a changed endpoint policy in place", async () => {
    const { service, spritesClient, repository } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-9" }),
      spriteLabels: ["session:session-1"],
    });
    spritesClient.connection = {
      id: "gateway-conn-9",
      provider: "custom_api",
      providerAccountName: "session-session-1-legacy",
      providerInfo: { base_api_url: "https://worker.test" },
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    };
    await repository.upsertActive({
      sessionId: "session-1",
      gatewayConnectionId: "gateway-conn-9",
      connectorName: "session-session-1-legacy",
      policySummary: spritesClient.connection.accessPolicy,
    });

    await reconcileConnector(service);

    expect(spritesClient.createdRequests).toHaveLength(0);
    expect(spritesClient.connection.accessPolicy?.allowedEndpoints).toContain(
      "/internal/session/session-1/git-token",
    );
  });

  it("replaces a connector whose base URL cannot be updated in place", async () => {
    const { service, spritesClient, repository, serverState } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-old" }),
      spriteLabels: ["session:session-1"],
    });
    spritesClient.connection = {
      id: "gateway-conn-old",
      provider: "custom_api",
      providerAccountName: "session-session-1-legacy",
      providerInfo: { base_api_url: "https://old-worker.test" },
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
      },
    };
    await repository.upsertActive({
      sessionId: "session-1",
      gatewayConnectionId: "gateway-conn-old",
      connectorName: "session-session-1-legacy",
      policySummary: spritesClient.connection.accessPolicy,
    });

    await reconcileConnector(service);

    expect(spritesClient.createdRequests).toHaveLength(1);
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");
    expect(spritesClient.deletedIds).toContain("gateway-conn-old");
  });

  it("adopts an uncertain create only through its durable attempt name", async () => {
    const { service, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    spritesClient.createBeforeError = true;
    spritesClient.createError = { code: "sprites_request_failed", retryable: true };

    await reconcileConnector(service);

    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectionId: "gateway-conn-1",
      desiredRevision: "a".repeat(64),
    });
    expect(repository.attempts.has("session-1")).toBe(false);
  });

  it("rewrites a stale D1 mirror from verified external state without storing the token", async () => {
    const { service, spritesClient, repository, serverState } = createService({
      spriteLabels: ["session:session-1"],
    });
    spritesClient.connection = {
      id: "gateway-conn-9",
      provider: "custom_api",
      providerAccountName: "session-session-1-legacy",
      providerInfo: { base_api_url: "https://worker.test" },
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: [...createConnectorContract().accessPolicy.allowedEndpoints],
        blockedEndpoints: [],
      },
    };
    await repository.upsertActive({
      sessionId: "session-1",
      gatewayConnectionId: "gateway-conn-9",
      connectorName: "session-session-1-legacy",
      policySummary: spritesClient.connection.accessPolicy,
    });

    await reconcileConnector(service);

    expect(serverState.sessionConnectorId).toBe("gateway-conn-9");
    expect(JSON.stringify(repository.rows.get("session-1"))).not.toContain(
      "webhook-token-value",
    );
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
    await reconcileConnector(service);
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");

    await service.deleteForTeardown();

    expect(spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(repository.rows.has("session-1")).toBe(false);
  });

  it("keeps a pending_revocation record when external deletion fails", async () => {
    const { service, spritesClient, repository } = createService({
      spriteLabels: ["session:session-1"],
    });
    await reconcileConnector(service);
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
