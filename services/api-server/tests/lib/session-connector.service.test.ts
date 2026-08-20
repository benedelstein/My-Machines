import { describe, expect, it, vi } from "vitest";
import { failure, success, type Result, type SessionEnvironmentSnapshot } from "@repo/shared";
import type {
  AccessPolicy,
  CreateCustomApiConnectorRequest,
  SpriteConnectorsClient,
  SpriteResponse,
  SpriteConnector,
  SpritesRestError,
} from "@repo/sprites-client";
import type { Env } from "../../src/shared/types";
import type {
  SessionConnectorRecord,
  SessionConnectorsRepository,
} from "../../src/modules/session-agent/repositories/session-connectors.repository";
import type { SessionConnectorContract } from
  "../../src/modules/session-agent/types/runtime-migration-adopters.types";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import {
  buildSessionSpriteLabels,
  SessionConnectorService,
} from "../../src/modules/session-agent/services/session-connector.service";
import { createTestLogger } from "./test-logger";

class FakeSpritesClient implements SpriteConnectorsClient {
  readonly connectors = new Map<string, SpriteConnector>();
  readonly createdRequests: CreateCustomApiConnectorRequest[] = [];
  readonly deletedIds: string[] = [];
  readonly getIds: string[] = [];
  readonly updatedIds: string[] = [];
  readonly operations: string[] = [];
  createError: SpritesRestError | null = null;
  createBeforeError = false;
  createTransform: ((connector: SpriteConnector) => SpriteConnector) | null = null;
  policyUpdateTransform: ((connector: SpriteConnector) => SpriteConnector) | null = null;
  deleteError: SpritesRestError | null = null;
  listCalls = 0;
  private nextConnectorId = 1;

  async createCustomApiConnector(
    request: CreateCustomApiConnectorRequest,
  ): Promise<Result<SpriteConnector, SpritesRestError>> {
    this.createdRequests.push(request);
    this.operations.push("create");
    const connector = this.buildCreatedConnector(request);
    if (this.createError) {
      if (this.createBeforeError) {
        this.connectors.set(connector.id, connector);
      }
      return failure(this.createError);
    }
    this.connectors.set(connector.id, connector);
    return success(connector);
  }

  async listConnectors(): Promise<Result<SpriteConnector[], SpritesRestError>> {
    this.listCalls += 1;
    return success([...this.connectors.values()]);
  }

  async updateAccessPolicy(
    connectorId: string,
    accessPolicy: AccessPolicy,
  ): Promise<Result<SpriteConnector, SpritesRestError>> {
    this.updatedIds.push(connectorId);
    this.operations.push(`update:${connectorId}`);
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return failure({ code: "sprites_request_failed", retryable: false });
    }
    const updated = this.policyUpdateTransform?.({ ...connector, accessPolicy })
      ?? { ...connector, accessPolicy };
    this.connectors.set(connectorId, updated);
    return success(updated);
  }

  async getConnector(
    connectorId: string,
  ): Promise<Result<SpriteConnector | null, SpritesRestError>> {
    this.getIds.push(connectorId);
    this.operations.push(`get:${connectorId}`);
    return success(this.connectors.get(connectorId) ?? null);
  }

  async deleteConnector(connectorId: string): Promise<Result<void, SpritesRestError>> {
    this.deletedIds.push(connectorId);
    this.operations.push(`delete:${connectorId}`);
    if (this.deleteError) {
      return failure(this.deleteError);
    }
    this.connectors.delete(connectorId);
    return success(undefined);
  }

  addConnector(connector: SpriteConnector): void {
    this.connectors.set(connector.id, connector);
  }

  private buildCreatedConnector(
    request: CreateCustomApiConnectorRequest,
  ): SpriteConnector {
    const connector: SpriteConnector = {
      id: `gateway-conn-${this.nextConnectorId++}`,
      provider: "custom_api",
      providerAccountName: request.name,
      providerInfo: {
        base_api_url: request.baseApiUrl,
        test_url: request.testUrl,
      },
      accessPolicy: request.accessPolicy,
    };
    return this.createTransform?.(connector) ?? connector;
  }
}

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    teardownStarted: false,
    sessionId: "session-1",
    userId: "user-1",
    spriteName: "sprite-1",
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    activeTurnDispatchStatus: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    sessionConnectorId: null,
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

function createFakeRepository(operations: string[]) {
  const rows = new Map<string, SessionConnectorRecord>();
  const repository = {
    rows,
    upsertError: null as Error | null,
    get: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
    upsertActive: vi.fn(async (params: {
      sessionId: string;
      gatewayConnectorId: string;
      connectorName: string;
      policySummary: AccessPolicy;
    }) => {
      operations.push(`upsert:${params.gatewayConnectorId}`);
      if (repository.upsertError) {
        throw repository.upsertError;
      }
      rows.set(params.sessionId, {
        sessionId: params.sessionId,
        gatewayConnectorId: params.gatewayConnectorId,
        connectorName: params.connectorName,
        policySummary: params.policySummary,
        status: "active",
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
      });
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
  freshSpriteSnapshot?: SpriteResponse | null;
} = {}) {
  const serverState = args.serverState ?? createServerState();
  const spritesClient = new FakeSpritesClient();
  const repository = createFakeRepository(spritesClient.operations);
  const updateServerState = vi.fn((partial: Partial<ServerState>) => {
    Object.assign(serverState, partial);
    if (partial.sessionConnectorId) {
      spritesClient.operations.push(`state:${partial.sessionConnectorId}`);
    }
  });
  const updateSprite = vi.fn(async (_name: string, request: { labels?: string[] }) => ({
    name: "sprite-1",
    labels: request.labels,
  }));
  const spriteLifecycleClient = {
    getSprite: vi.fn(async () => ({
      name: "sprite-1",
      labels: args.spriteLabels ?? ["session:session-1"],
    })),
    updateSprite,
  };
  const ensureWebhookToken = vi.fn(() => "webhook-token-value");
  let freshSpriteSnapshot = args.freshSpriteSnapshot ?? null;
  const takeFreshSpriteSnapshot = vi.fn(() => {
    const snapshot = freshSpriteSnapshot;
    freshSpriteSnapshot = null;
    return snapshot;
  });

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
    takeFreshSpriteSnapshot,
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
    takeFreshSpriteSnapshot,
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
    spriteLabels: buildSessionSpriteLabels(
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

function desiredPolicy(contract = createConnectorContract()): AccessPolicy {
  return {
    allowAll: false,
    spriteLabels: ["session:session-1"],
    allowedEndpoints: [...contract.accessPolicy.allowedEndpoints],
    blockedEndpoints: [...contract.accessPolicy.blockedEndpoints],
  };
}

function compatibleConnector(
  id: string,
  overrides: Partial<SpriteConnector> = {},
): SpriteConnector {
  return {
    id,
    provider: "custom_api",
    providerAccountName: `diagnostic-${id}`,
    providerInfo: {
      base_api_url: "https://worker.test/",
      test_url: "https://worker.test/health",
    },
    accessPolicy: desiredPolicy(),
    ...overrides,
  };
}

async function reconcileConnector(
  service: SessionConnectorService,
  contract = createConnectorContract(),
): Promise<void> {
  await service.reconcile({ contract });
}

async function recordConnector(
  repository: ReturnType<typeof createFakeRepository>,
  connector: SpriteConnector,
): Promise<void> {
  await repository.upsertActive({
    sessionId: "session-1",
    gatewayConnectorId: connector.id,
    connectorName: connector.providerAccountName ?? "diagnostic",
    policySummary: connector.accessPolicy ?? desiredPolicy(),
  });
  repository.upsertActive.mockClear();
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
  it("creates, verifies, and checkpoints a connector without enumerating providers", async () => {
    const { service, serverState, spritesClient, repository } = createService();

    await reconcileConnector(service);

    expect(spritesClient.createdRequests).toHaveLength(1);
    expect(spritesClient.createdRequests[0]).toMatchObject({
      name: expect.stringMatching(/^session-session-1-[a-f0-9]{8}$/u),
      baseApiUrl: "https://worker.test",
      accessToken: "webhook-token-value",
      testUrl: "https://worker.test/health",
      accessPolicy: desiredPolicy(),
    });
    expect(serverState.sessionConnectorId).toBe("gateway-conn-1");
    expect(repository.rows.get("session-1")).toMatchObject({
      gatewayConnectorId: "gateway-conn-1",
      status: "active",
    });
    expect(spritesClient.listCalls).toBe(0);
  });

  it("uses a matching fresh Sprite snapshot once and avoids the immediate read", async () => {
    const fixture = createService({
      freshSpriteSnapshot: {
        name: "sprite-1",
        labels: ["session:session-1"],
      },
    });

    await reconcileConnector(fixture.service);
    expect(fixture.spriteLifecycleClient.getSprite).not.toHaveBeenCalled();

    await reconcileConnector(fixture.service);
    expect(fixture.spriteLifecycleClient.getSprite).toHaveBeenCalledOnce();
    expect(fixture.takeFreshSpriteSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", null],
    ["name mismatch", { name: "different-sprite", labels: ["session:session-1"] }],
    ["labels omitted", { name: "sprite-1" }],
  ])("falls back to GET when the fresh snapshot is %s", async (_label, snapshot) => {
    const fixture = createService({ freshSpriteSnapshot: snapshot });

    await reconcileConnector(fixture.service);

    expect(fixture.spriteLifecycleClient.getSprite).toHaveBeenCalledOnce();
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("replaces stale labels with the exact desired label set", async () => {
    const contract = createConnectorContract(createEnvironmentSnapshot({
      sourceEnvironmentId: "environment-1",
    }));
    const fixture = createService({
      freshSpriteSnapshot: {
        name: "sprite-1",
        labels: ["session:stale-session", "env:stale-environment", "unrelated"],
      },
    });

    await reconcileConnector(fixture.service, contract);

    expect(fixture.spriteLifecycleClient.getSprite).not.toHaveBeenCalled();
    expect(fixture.spriteLifecycleClient.updateSprite).toHaveBeenCalledWith("sprite-1", {
      labels: ["session:session-1", "env:environment-1"],
    });
  });

  it("fails before connector reads when the updated label set is not exact", async () => {
    const fixture = createService({ spriteLabels: ["unrelated"] });
    fixture.spriteLifecycleClient.updateSprite.mockResolvedValue({
      name: "sprite-1",
      labels: ["session:session-1", "unrelated"],
    });

    await expect(reconcileConnector(fixture.service)).rejects.toThrow(
      "Sprite label update did not persist the desired label set",
    );

    expect(fixture.spritesClient.getIds).toHaveLength(0);
    expect(fixture.spritesClient.createdRequests).toHaveLength(0);
  });

  it("reuses a structurally compatible connector strictly by ServerState ID", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-state", {
      providerAccountName: "totally-unrelated-diagnostic-name",
    }));

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.createdRequests).toHaveLength(0);
    expect(fixture.spritesClient.getIds).toEqual(["connector-state"]);
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("updates a stale policy in place without a second read", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-state", {
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
        blockedEndpoints: [],
      },
    }));

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.updatedIds).toEqual(["connector-state"]);
    expect(fixture.spritesClient.connectors.get("connector-state")?.accessPolicy)
      .toEqual(desiredPolicy());
    expect(fixture.spritesClient.getIds).toEqual(["connector-state"]);
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("compares every access-policy collection without depending on order", async () => {
    const contract: SessionConnectorContract = {
      ...createConnectorContract(),
      accessPolicy: {
        allowedEndpoints: ["/first", "/second"],
        blockedEndpoints: ["/blocked-first", "/blocked-second"],
      },
    };
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-state", {
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/second", "/first"],
        blockedEndpoints: ["/blocked-second", "/blocked-first"],
      },
    }));

    await reconcileConnector(fixture.service, contract);

    expect(fixture.spritesClient.updatedIds).toHaveLength(0);
  });

  it("rejects a policy update response that does not match the desired policy", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-state", {
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    }));
    fixture.spritesClient.policyUpdateTransform = (connector) => ({
      ...connector,
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    });

    await expect(reconcileConnector(fixture.service)).rejects.toThrow(
      "Session connector policy update response did not match desired state",
    );

    expect(fixture.repository.upsertActive).not.toHaveBeenCalled();
    expect(fixture.updateServerState).not.toHaveBeenCalled();
  });

  it.each([
    ["provider", { provider: "github" }],
    ["base URL", { providerInfo: {
      base_api_url: "https://old-worker.test",
      test_url: "https://worker.test/health",
    } }],
    ["test URL", { providerInfo: {
      base_api_url: "https://worker.test",
      test_url: "https://worker.test/old-health",
    } }],
    ["missing structural fields", { providerInfo: {} }],
  ])("replaces a connector with a %s mismatch", async (_label, overrides) => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-old" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-old", overrides));

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.createdRequests).toHaveLength(1);
    expect(fixture.spritesClient.deletedIds).toContain("connector-old");
    expect(fixture.serverState.sessionConnectorId).toBe("gateway-conn-1");
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("falls back to the compatible D1 ID and cleans up the disagreeing State ID", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    const stateConnector = compatibleConnector("connector-state", {
      providerInfo: {
        base_api_url: "https://old-worker.test",
        test_url: "https://worker.test/health",
      },
    });
    const d1Connector = compatibleConnector("connector-d1");
    fixture.spritesClient.addConnector(stateConnector);
    fixture.spritesClient.addConnector(d1Connector);
    await recordConnector(fixture.repository, d1Connector);

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.createdRequests).toHaveLength(0);
    expect(fixture.spritesClient.deletedIds).toContain("connector-state");
    expect(fixture.serverState.sessionConnectorId).toBe("connector-d1");
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("ignores a null State lookup and still adopts the compatible D1 ID", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-missing" }),
    });
    const d1Connector = compatibleConnector("connector-d1");
    fixture.spritesClient.addConnector(d1Connector);
    await recordConnector(fixture.repository, d1Connector);

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.createdRequests).toHaveLength(0);
    expect(fixture.serverState.sessionConnectorId).toBe("connector-d1");
    expect(fixture.spritesClient.deletedIds).toContain("connector-missing");
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("prefers the compatible State ID and deletes a second compatible D1 ID", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-state" }),
    });
    const stateConnector = compatibleConnector("connector-state");
    const d1Connector = compatibleConnector("connector-d1");
    fixture.spritesClient.addConnector(stateConnector);
    fixture.spritesClient.addConnector(d1Connector);
    await recordConnector(fixture.repository, d1Connector);

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.deletedIds).toContain("connector-d1");
    expect(fixture.serverState.sessionConnectorId).toBe("connector-state");
  });

  it("verifies a replacement before deleting the old known connector", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-old" }),
    });
    fixture.spritesClient.addConnector(compatibleConnector("connector-old", {
      provider: "wrong-provider",
    }));

    await reconcileConnector(fixture.service);

    const createdId = fixture.serverState.sessionConnectorId!;
    const replacementReadIndex = fixture.spritesClient.operations.lastIndexOf(`get:${createdId}`);
    const oldDeleteIndex = fixture.spritesClient.operations.indexOf("delete:connector-old");
    const upsertIndex = fixture.spritesClient.operations.indexOf(`upsert:${createdId}`);
    const stateIndex = fixture.spritesClient.operations.indexOf(`state:${createdId}`);
    expect(replacementReadIndex).toBeLessThan(oldDeleteIndex);
    expect(oldDeleteIndex).toBeLessThan(upsertIndex);
    expect(upsertIndex).toBeLessThan(stateIndex);
  });

  it("cleans up an unverified create and leaves old checkpoints untouched", async () => {
    const fixture = createService({
      serverState: createServerState({ sessionConnectorId: "connector-old" }),
    });
    const oldConnector = compatibleConnector("connector-old", { provider: "wrong-provider" });
    fixture.spritesClient.addConnector(oldConnector);
    fixture.spritesClient.createTransform = (connector) => ({
      ...connector,
      providerInfo: { base_api_url: "https://worker.test" },
    });

    await expect(reconcileConnector(fixture.service)).rejects.toThrow(
      "Session connector create verification failed",
    );

    expect(fixture.spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(fixture.spritesClient.deletedIds).not.toContain("connector-old");
    expect(fixture.repository.upsertActive).not.toHaveBeenCalled();
    expect(fixture.serverState.sessionConnectorId).toBe("connector-old");
    expect(fixture.spritesClient.listCalls).toBe(0);
  });

  it("deletes a create whose policy readback does not match the request", async () => {
    const fixture = createService();
    fixture.spritesClient.createTransform = (connector) => ({
      ...connector,
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    });

    await expect(reconcileConnector(fixture.service)).rejects.toThrow(
      "Session connector create verification failed",
    );

    expect(fixture.spritesClient.updatedIds).toHaveLength(0);
    expect(fixture.spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(fixture.repository.upsertActive).not.toHaveBeenCalled();
  });

  it("does not checkpoint when D1 persistence fails", async () => {
    const fixture = createService();
    fixture.repository.upsertError = new Error("D1 unavailable");

    await expect(reconcileConnector(fixture.service)).rejects.toThrow("D1 unavailable");

    expect(fixture.serverState.sessionConnectorId).toBeNull();
    expect(fixture.updateServerState).not.toHaveBeenCalled();
  });

  it("accepts an ambiguous-create orphan and creates anew on retry", async () => {
    const fixture = createService();
    fixture.spritesClient.createBeforeError = true;
    fixture.spritesClient.createError = {
      code: "sprites_request_failed",
      retryable: true,
    };

    await expect(reconcileConnector(fixture.service)).rejects.toThrow(
      "Session connector create failed",
    );
    const firstName = fixture.spritesClient.createdRequests[0]?.name;
    fixture.spritesClient.createError = null;

    await reconcileConnector(fixture.service);

    expect(fixture.spritesClient.createdRequests).toHaveLength(2);
    expect(fixture.spritesClient.createdRequests[1]?.name).not.toBe(firstName);
    expect(fixture.spritesClient.connectors.size).toBe(2);
    expect(fixture.serverState.sessionConnectorId).toBe("gateway-conn-2");
    expect(fixture.spritesClient.listCalls).toBe(0);
  });
});

describe("SessionConnectorService.getGatewayBase", () => {
  it("builds the gateway base from the checkpointed connector id", () => {
    const { service } = createService({
      serverState: createServerState({ sessionConnectorId: "gateway-conn-7" }),
    });

    expect(service.getGatewayBase()).toBe(
      "https://api.sprites.test/v1/gateway/custom_api/gateway-conn-7",
    );
  });

  it("returns null before a connector is minted", () => {
    expect(createService().service.getGatewayBase()).toBeNull();
  });
});

describe("SessionConnectorService.deleteForTeardown", () => {
  it("deletes the verified D1 connector and removes its metadata", async () => {
    const fixture = createService();
    await reconcileConnector(fixture.service);

    await fixture.service.deleteForTeardown();

    expect(fixture.spritesClient.deletedIds).toContain("gateway-conn-1");
    expect(fixture.repository.rows.has("session-1")).toBe(false);
  });

  it("keeps a pending_revocation record when external deletion fails", async () => {
    const fixture = createService();
    await reconcileConnector(fixture.service);
    fixture.spritesClient.deleteError = {
      code: "sprites_request_failed",
      retryable: true,
    };

    await fixture.service.deleteForTeardown();

    expect(fixture.repository.rows.get("session-1")).toMatchObject({
      gatewayConnectorId: "gateway-conn-1",
      status: "pending_revocation",
    });
  });

  it("is a no-op without a connector", async () => {
    const fixture = createService();

    await fixture.service.deleteForTeardown();

    expect(fixture.spritesClient.deletedIds).toHaveLength(0);
  });
});
