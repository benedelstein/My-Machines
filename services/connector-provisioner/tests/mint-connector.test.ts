import { describe, expect, it } from "vitest";
import { mintConnector } from "../src/mint-connector";
import type {
  AccessPolicy,
  DashboardConnectorClient,
  DashboardCreateError,
  DashboardCreateResult,
  MintConnectorRequest,
  Result,
  SpritesConnection,
  SpritesConnectionsClient,
  SpritesRestError,
} from "../src/types";
import { failure, success } from "../src/types";

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
  providerAccountName: request.name,
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

class FakeSpritesClient implements SpritesConnectionsClient {
  readonly deletedIds: string[] = [];
  readonly updatedPolicies: AccessPolicy[] = [];
  listCallCount = 0;
  listResponses: Array<Result<SpritesConnection[], SpritesRestError>> = [
    success([]),
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
    const sprites = new FakeSpritesClient();
    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
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
    expect(sprites.updatedPolicies).toEqual([{
      allowAll: false,
      spriteLabels: ["session:test-123"],
    }]);
    expect(sprites.deletedIds).toEqual([]);
  });

  it("deletes the partial connector when scope update fails", async () => {
    const sprites = new FakeSpritesClient();
    sprites.updateResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
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
    expect(sprites.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("fails closed and cleans up when allow_all remains enabled", async () => {
    const sprites = new FakeSpritesClient();
    sprites.getResult = success({
      ...createdConnection,
      accessPolicy: {
        allowAll: true,
        spriteLabels: [...request.spriteLabels],
      },
    });

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
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
    expect(sprites.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("reports cleanup failure without exposing the connector token", async () => {
    const sprites = new FakeSpritesClient();
    sprites.getResult = success({
      ...createdConnection,
      accessPolicy: {
        allowAll: true,
        spriteLabels: [...request.spriteLabels],
      },
    });
    sprites.deleteResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
    });
    const serialized = JSON.stringify(result);

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
    expect(serialized).not.toContain(request.token);
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("storageState");
  });

  it("does not submit a secret after dashboard preflight rejects the shape", async () => {
    const sprites = new FakeSpritesClient();
    const dashboardError: DashboardCreateError = {
      code: "dashboard_drift",
      retryable: false,
    };

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(failure(dashboardError)),
      sprites,
      now: clock(),
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
    expect(sprites.listCallCount).toBe(1);
  });

  it("deletes every attributable connector when reconciliation is ambiguous", async () => {
    const sprites = new FakeSpritesClient();
    sprites.listResponses = [
      success([]),
      success([
        createdConnection,
        { ...createdConnection, id: "second-gateway-id" },
      ]),
    ];

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_reconciliation_failed",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(sprites.deletedIds.sort()).toEqual([
      "gateway-connection-id",
      "second-gateway-id",
    ]);
  });

  it("does not accept one exact match when another same-name connector appears", async () => {
    const sprites = new FakeSpritesClient();
    sprites.listResponses = [
      success([]),
      success([
        createdConnection,
        {
          ...createdConnection,
          id: "same-name-different-target",
          providerInfo: {
            base_api_url: "https://example.com",
            test_url: "https://example.com/health",
          },
        },
      ]),
    ];

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_reconciliation_failed",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(sprites.deletedIds.sort()).toEqual([
      "gateway-connection-id",
      "same-name-different-target",
    ]);
  });

  it("cleans up rather than throwing when Sprites returns malformed provider URLs", async () => {
    const sprites = new FakeSpritesClient();
    sprites.listResponses = [
      success([]),
      success([{
        ...createdConnection,
        providerInfo: {
          base_api_url: "not a URL",
          test_url: request.testUrl,
        },
      }]),
    ];

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_reconciliation_failed",
        cleanup: {
          attempted: true,
          succeeded: true,
        },
      },
    });
    expect(sprites.deletedIds).toEqual(["gateway-connection-id"]);
  });

  it("retries list-after and reports an orphan condition if REST remains unavailable", async () => {
    const sprites = new FakeSpritesClient();
    const listFailure = failure<SpritesRestError>({
      code: "sprites_request_failed",
      retryable: true,
    });
    sprites.listResponses = [
      success([]),
      listFailure,
      listFailure,
      listFailure,
      listFailure,
    ];
    const retryDelays: number[] = [];

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
      sleep: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "orphan_reconciliation_required",
        stage: "list_after",
        cleanup: {
          attempted: false,
        },
      },
    });
    expect(retryDelays).toEqual([250, 750, 1_500]);
  });

  it("rejects a non-unique connector name before browser submission", async () => {
    const sprites = new FakeSpritesClient();
    sprites.listResponses = [success([createdConnection])];
    const dashboard = new FakeDashboardClient(success(dashboardSuccess));

    const result = await mintConnector(request, {
      dashboard,
      sprites,
      now: clock(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_name_conflict",
        stage: "list_before",
      },
    });
    expect(dashboard.callCount).toBe(0);
  });

  it("retries successful empty lists until the created connector becomes visible", async () => {
    const sprites = new FakeSpritesClient();
    sprites.listResponses = [
      success([]),
      success([]),
      success([]),
      success([createdConnection]),
    ];
    const retryDelays: number[] = [];

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(success(dashboardSuccess)),
      sprites,
      now: clock(),
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
    expect(retryDelays).toEqual([250, 750]);
  });

  it("discovers and deletes an orphan when navigation fails after submit", async () => {
    const sprites = new FakeSpritesClient();
    const dashboardError: DashboardCreateError = {
      code: "dashboard_create_failed",
      retryable: true,
      submitAttempted: true,
    };

    const result = await mintConnector(request, {
      dashboard: new FakeDashboardClient(failure(dashboardError)),
      sprites,
      now: clock(),
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
    expect(sprites.deletedIds).toEqual(["gateway-connection-id"]);
  });
});
