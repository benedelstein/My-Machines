import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  CreateCustomApiConnectorRequest,
  SpriteConnectorsClient,
  SpriteConnector,
  SpritesRestError,
} from "@repo/sprites-client";
import { describe, expect, it } from "vitest";
import {
  deleteConnectorAndVerify,
  mintConnector,
} from "../../src/shared/integrations/sprite-connectors/connector-provisioning.service";

const accessPolicy: AccessPolicy = {
  allowAll: false,
  spriteLabels: ["session:test-123"],
  allowedEndpoints: ["/headers"],
};

const request: CreateCustomApiConnectorRequest = {
  name: "connector-test",
  baseApiUrl: "https://httpbin.org",
  accessToken: "dummy-secret-that-must-not-leak",
  testUrl: "https://httpbin.org/headers",
  authHeaderPrefix: "Bearer",
  description: "Provisioned by My Machines",
  accessPolicy,
};

function connector(overrides: Partial<SpriteConnector> = {}): SpriteConnector {
  return {
    id: "gateway-connector-id",
    provider: "custom_api",
    providerAccountName: "connector-test-suffix01",
    providerInfo: {
      base_api_url: "https://httpbin.org",
      test_url: "https://httpbin.org/headers",
    },
    accessPolicy,
    ...overrides,
  };
}

class FakeSpritesClient implements SpriteConnectorsClient {
  readonly createdRequests: CreateCustomApiConnectorRequest[] = [];
  readonly deletedIds: string[] = [];
  createResult: Result<SpriteConnector, SpritesRestError> = success(connector());
  listResults: Array<Result<SpriteConnector[], SpritesRestError>> = [success([])];
  getResults: Array<Result<SpriteConnector | null, SpritesRestError>> = [
    success(connector()),
  ];
  deleteResult: Result<void, SpritesRestError> = success(undefined);

  async createCustomApiConnector(
    createRequest: CreateCustomApiConnectorRequest,
  ): Promise<Result<SpriteConnector, SpritesRestError>> {
    this.createdRequests.push(createRequest);
    return this.createResult;
  }

  async listConnectors(): Promise<Result<SpriteConnector[], SpritesRestError>> {
    return this.listResults.shift() ?? success([]);
  }

  async updateAccessPolicy(): Promise<Result<SpriteConnector, SpritesRestError>> {
    throw new Error("Mint must set the final policy during creation.");
  }

  async getConnector(): Promise<Result<SpriteConnector | null, SpritesRestError>> {
    return this.getResults.shift() ?? success(null);
  }

  async deleteConnector(connectorId: string): Promise<Result<void, SpritesRestError>> {
    this.deletedIds.push(connectorId);
    return this.deleteResult;
  }
}

describe("mintConnector", () => {
  it("creates with the final policy and verifies the returned connector id", async () => {
    const spritesClient = new FakeSpritesClient();

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        name: "connector-test-suffix01",
        gatewayConnectorId: "gateway-connector-id",
        accessPolicy,
      },
    });
    expect(spritesClient.createdRequests).toEqual([{
      name: "connector-test-suffix01",
      baseApiUrl: "https://httpbin.org",
      accessToken: "dummy-secret-that-must-not-leak",
      testUrl: "https://httpbin.org/headers",
      authHeaderPrefix: "Bearer",
      description: "Provisioned by My Machines",
      accessPolicy,
    }]);
  });

  it("returns a non-retryable create failure without reconciliation", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.createResult = failure({
      code: "sprites_authentication_failed",
      retryable: false,
    });

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "sprites_authentication_failed",
        stage: "create",
        retryable: false,
        cleanup: { attempted: false, succeeded: false },
      },
    });
    expect(spritesClient.listResults).toHaveLength(1);
  });

  it("reports uncertain reconciliation when a retryable create has no name match", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.createResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });
    spritesClient.listResults = [success([]), success([]), success([]), success([])];

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "orphan_reconciliation_required",
        stage: "reconcile",
        retryable: true,
        cleanup: { attempted: false, succeeded: false },
      },
    });
  });

  it("deletes a connector found after an uncertain create response", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.createResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });
    spritesClient.listResults = [success([connector()])];
    spritesClient.getResults = [success(null)];

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "sprites_request_failed",
        stage: "create",
        retryable: false,
        cleanup: { attempted: true, succeeded: true },
      },
    });
    expect(spritesClient.deletedIds).toEqual(["gateway-connector-id"]);
  });

  it("reconciles an invalid create response because the connector may exist", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.createResult = failure({
      code: "sprites_response_invalid",
      retryable: false,
    });
    spritesClient.listResults = [success([connector()])];
    spritesClient.getResults = [success(null)];

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "sprites_response_invalid",
        cleanup: { attempted: true, succeeded: true },
      },
    });
  });

  it("deletes a connector whose persisted policy does not match", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResults = [
      success(connector({
        accessPolicy: {
          allowAll: true,
          spriteLabels: ["session:test-123"],
        },
      })),
      success(null),
    ];

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_verification_failed",
        stage: "verify",
        cleanup: { attempted: true, succeeded: true },
      },
    });
    expect(spritesClient.deletedIds).toEqual(["gateway-connector-id"]);
  });

  it("surfaces the orphan id when delete fails after a verification mismatch", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResults = [success(connector({
      accessPolicy: {
        allowAll: true,
        spriteLabels: ["session:test-123"],
      },
    }))];
    spritesClient.deleteResult = failure({
      code: "sprites_request_failed",
      retryable: true,
    });

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_verification_failed",
        cleanup: {
          attempted: true,
          succeeded: false,
          gatewayConnectorId: "gateway-connector-id",
          error: {
            code: "cleanup_failed",
            cause: "sprites_request_failed",
            retryable: true,
          },
        },
      },
    });
  });

  it("surfaces the orphan id when a connector remains after delete", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResults = [
      success(connector({
        accessPolicy: {
          allowAll: true,
          spriteLabels: ["session:test-123"],
        },
      })),
      success(connector()),
    ];

    const result = await mintConnector(request, {
      spritesClient,
      nameSuffix: () => "suffix01",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_verification_failed",
        cleanup: {
          attempted: true,
          succeeded: false,
          gatewayConnectorId: "gateway-connector-id",
          error: {
            code: "cleanup_failed",
            cause: "connector_still_present",
            retryable: true,
          },
        },
      },
    });
  });
});

describe("deleteConnectorAndVerify", () => {
  it("succeeds only after the deleted connector reads as missing", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResults = [success(null)];

    const result = await deleteConnectorAndVerify("gateway-connector-id", spritesClient);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(spritesClient.deletedIds).toEqual(["gateway-connector-id"]);
  });

  it("fails when a connector remains after delete", async () => {
    const spritesClient = new FakeSpritesClient();
    spritesClient.getResults = [success(connector())];

    const result = await deleteConnectorAndVerify("gateway-connector-id", spritesClient);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cleanup_failed",
        cause: "connector_still_present",
        retryable: true,
      },
    });
  });
});
