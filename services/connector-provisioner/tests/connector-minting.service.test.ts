import { describe, expect, it } from "vitest";
import { deleteConnectorAndVerify, mintConnector } from "../src/connector-minting.service";
import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  SpritesConnection,
  SpriteConnectorsClient,
  SpritesRestError,
} from "@repo/sprites-client";
import type { MintConnectorRequest } from "../src/connectors.schema";
import type {
  DashboardConnectorClient,
  DashboardCreateError,
  DashboardCreateResult,
} from "../src/types";

const request: MintConnectorRequest = {
  name: "connector-test-123",
  baseApiUrl: "https://httpbin.org",
  token: "dummy-secret-that-must-not-leak",
  testUrl: "https://httpbin.org/headers",
  headerName: "Authorization",
  headerPrefix: "Bearer",
  spriteLabels: ["session:test-123"],
};

const createdConnection: SpritesConnection = {
  id: "gateway-connection-id",
  provider: "custom_api",
  providerAccountName: `${request.name}-suffix01`,
  providerInfo: {
    base_api_url: "https://httpbin.org/",
    test_url: request.testUrl,
  },
  accessPolicy: {
    allowAll: false,
    spriteLabels: [],
  },
};

const dashboardSuccess: DashboardCreateResult = {
  detailId: "dashboard-detail-id",
  durations: {
    browserLaunchMs: 10,
    dashboardPreflightMs: 20,
    dashboardTestMs: 30,
    dashboardCreateMs: 40,
  },
};

class FakeDashboardClient implements DashboardConnectorClient {
  callCount = 0;

  constructor(
    private readonly result: Result<DashboardCreateResult, DashboardCreateError>,
  ) {}

  async createConnector(): Promise<Result<DashboardCreateResult, DashboardCreateError>> {
    this.callCount += 1;
    return this.result;
  }
}

class FakeSpritesClient implements SpriteConnectorsClient {
  readonly deletedIds: string[] = [];
  readonly updatedPolicies: AccessPolicy[] = [];
  listCallCount = 0;
  listResponses: Array<Result<SpritesConnection[], SpritesRestError>> = [
    success([createdConnection]),
  ];
  updateResult: Result<SpritesConnection, SpritesRestError> = success(createdConnection);
  getResult: Result<SpritesConnection | null, SpritesRestError> = success({
    ...createdConnection,
    accessPolicy: {
      allowAll: false,
      spriteLabels: [...request.spriteLabels],
    },
  });
  deleteResult: Result<void, SpritesRestError> = success(undefined);

  async listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>> {
    const response = this.listResponses[this.listCallCount];
    this.listCallCount += 1;
    return response ?? failure({
      code: "sprites_request_failed",
      retryable: true,
    });
  }

  async updateAccessPolicy(
    _connectionId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpritesConnection, SpritesRestError>> {
    this.updatedPolicies.push(policy);
    return this.updateResult;
  }

  async getConnection(
    connectionId: string,
  ): Promise<Result<SpritesConnection | null, SpritesRestError>> {
    if (this.deletedIds.includes(connectionId)) {
      return success(null);
    }
    return this.getResult;
  }

  async deleteConnection(connectionId: string): Promise<Result<void, SpritesRestError>> {
    this.deletedIds.push(connectionId);
    return this.deleteResult;
  }
}

function clock(): () => number {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}

describe("mintConnector", () => {
  it("creates, reconciles, scopes, and verifies a connector", async () => {
    const spritesClient = new FakeSpritesClient();
    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        gatewayConnectionId: "gateway-connection-id",
        detailId: "dashboard-detail-id",
        accessPolicy: {
          allowAll: false,
          spriteLabels: ["session:test-123"],
        },
      },
    });
    expect(spritesClient.updatedPolicies).toEqual([{
      allowAll: false,
      spriteLabels: ["session:test-123"],
    }]);
    expect(spritesClient.deletedIds).toEqual([]);
  });

  it("deletes the partial connector when scope update fails", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.updateResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "sprites_request_failed",
        stage: "scope",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(spritesClient.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("fails closed and cleans up when allow_all remains enabled", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResult = success({
      ...createdConnection,
      accessPolicy: {
        allowAll: true,
        spriteLabels: [...request.spriteLabels],
      },
    });

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "policy_verification_failed",
        stage: "verify",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(spritesClient.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("reports a failed cleanup instead of claiming the connector was removed", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResult = success({
      ...createdConnection,
      accessPolicy: {
        allowAll: true,
        spriteLabels: [...request.spriteLabels],
      },
    });
    spritesClient.deleteResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "policy_verification_failed",
        cleanup: {
          attempted: true,
          succeeded: false,
        },
      },
    });
  });

  it("skips list reconciliation when the dashboard failed before submitting", async () => {
    const spritesClient = new FakeSpritesClient();
    const dashboardError: DashboardCreateError = {
      code: "dashboard_drift",
      retryable: false,
    };

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(failure(dashboardError)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "dashboard_drift",
        stage: "dashboard_create",
        cleanup: {
          attempted: false,
        },
      },
    });
    expect(spritesClient.listCallCount).toBe(0);
  });

  it("attributes only its own connector when a concurrent same-name mint is visible", async () => {
    const concurrentTwin: SpritesConnection = {
      ...createdConnection,
      id: "concurrent-gateway-id",
      providerAccountName: `${request.name}-suffix02`,
    };
    const spritesClient = new FakeSpritesClient();
    spritesClient.listResponses = [
      success([concurrentTwin, createdConnection]),
    ];

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        name: `${request.name}-suffix01`,
        gatewayConnectionId: "gateway-connection-id",
      },
    });
    expect(spritesClient.deletedIds).toEqual([]);
  });

  it("attributes by name alone, whatever provider_info reports", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.listResponses = [
      success([{
        ...createdConnection,
        providerInfo: { base_api_url: "not a URL" },
      }]),
    ];

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gatewayConnectionId: "gateway-connection-id" },
    });
    expect(spritesClient.deletedIds).toEqual([]);
  });

  it("reports an orphan condition when the connector never becomes visible", async () => {
    const spritesClient = new FakeSpritesClient();
    const listFailure = failure<SpritesRestError>({
      code: "sprites_request_failed",
      retryable: true,
    });
    spritesClient.listResponses = [listFailure, listFailure, listFailure, listFailure];
    const retryDelays: number[] = [];

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
      sleep: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "orphan_reconciliation_required",
        stage: "list_after",
        retryable: true,
        cleanup: {
          attempted: false,
        },
      },
    });
    // Every attempt after the first backs off, rather than hammering the API.
    expect(spritesClient.listCallCount).toBe(retryDelays.length + 1);
    expect(retryDelays.every((milliseconds) => milliseconds > 0)).toBe(true);
  });

  it("retries until the created connector becomes visible", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.listResponses = [
      success([]),
      success([]),
      success([createdConnection]),
    ];
    const retryDelays: number[] = [];

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
      sleep: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        gatewayConnectionId: "gateway-connection-id",
      },
    });
    expect(spritesClient.listCallCount).toBe(3);
    expect(retryDelays).toHaveLength(2);
  });

  it("discovers and deletes an orphan when navigation fails after submit", async () => {
    const spritesClient = new FakeSpritesClient();
    const dashboardError: DashboardCreateError = {
      code: "dashboard_create_failed",
      retryable: true,
      submitAttempted: true,
    };

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(failure(dashboardError)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "dashboard_create_failed",
        stage: "dashboard_create",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(spritesClient.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("deletes nothing after an uncertain submit that created no connector", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.listResponses = [success([])];

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(failure({
        code: "dashboard_create_failed",
        retryable: true,
        submitAttempted: true,
      })),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "orphan_reconciliation_required",
        stage: "list_after",
        retryable: true,
        cleanup: {
          attempted: false,
        },
      },
    });
    expect(spritesClient.deletedIds).toEqual([]);
  });

  it("times only the stages that ran", async () => {
    const spritesClient = new FakeSpritesClient();

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    if (!result.ok) {
      throw new Error(`Expected a successful mint, got ${result.error.code}`);
    }
    // No cleanupMs: nothing was cleaned up on the happy path.
    expect(Object.keys(result.value.durations).sort()).toEqual([
      "browserLaunchMs",
      "dashboardCreateMs",
      "dashboardPreflightMs",
      "dashboardTestMs",
      "listAfterMs",
      "scopeMs",
      "totalMs",
      "verifyMs",
    ]);
  });

  it("times the cleanup that a failed scope triggers, and no later stage", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.updateResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(success(dashboardSuccess)),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    if (result.ok) {
      throw new Error("Expected the mint to fail");
    }
    expect(Object.keys(result.error.durations).sort()).toEqual([
      "browserLaunchMs",
      "cleanupMs",
      "dashboardCreateMs",
      "dashboardPreflightMs",
      "dashboardTestMs",
      "listAfterMs",
      "scopeMs",
      "totalMs",
    ]);
  });

  it("keeps the dashboard's own stage timings instead of inventing a create timing", async () => {
    const spritesClient = new FakeSpritesClient();

    const result = await mintConnector(request, {
      dashboardClient: new FakeDashboardClient(failure({
        code: "dashboard_browser_failed",
        retryable: true,
        operation: "browser_launch",
        durations: { browserLaunchMs: 12 },
      })),
      spritesClient,
      now: clock(),
      nameSuffix: () => "suffix01",
    });

    if (result.ok) {
      throw new Error("Expected the mint to fail");
    }
    expect(result.error.durations).toMatchObject({ browserLaunchMs: 12 });
    expect(Object.keys(result.error.durations).sort()).toEqual([
      "browserLaunchMs",
      "totalMs",
    ]);
  });
});

describe("deleteConnectorAndVerify", () => {
  it("succeeds once the connector no longer resolves", async () => {
    const spritesClient = new FakeSpritesClient();

    const result = await deleteConnectorAndVerify("gateway-connection-id", spritesClient);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(spritesClient.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("keeps the underlying Sprites failure as the cleanup cause", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.deleteResult = failure({
      code: "sprites_rate_limited",
      retryable: true,
    });

    const result = await deleteConnectorAndVerify("gateway-connection-id", spritesClient);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cleanup_failed",
        retryable: true,
        cause: "sprites_rate_limited",
      },
    });
  });

  it("fails when the connector is still present after a successful delete", async () => {
    const spritesClient = new FakeSpritesClient();
    // Delete reports success but the connector keeps resolving afterwards.
    spritesClient.getConnection = async () => success(createdConnection);

    const result = await deleteConnectorAndVerify("gateway-connection-id", spritesClient);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cleanup_failed",
        retryable: true,
        cause: "connector_still_present",
      },
    });
  });
});
