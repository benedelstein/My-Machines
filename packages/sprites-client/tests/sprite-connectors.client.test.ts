import { describe, expect, it, vi } from "vitest";
import { HttpSpriteConnectorsClient } from "../src/sprite-connectors.client";
import { CreateCustomApiConnectorRequestSchema } from "../src/types";

const connectionPayload = {
  id: "connection-1",
  provider: "custom_api",
  provider_account_name: "cloude-session-abc123",
  provider_info: { base_api_url: "https://api.example.com" },
  access_policy: {
    allow_all: false,
    sprite_labels: ["session:session-1"],
  },
};

function client(fetchImplementation: typeof fetch): HttpSpriteConnectorsClient {
  return new HttpSpriteConnectorsClient({
    apiUrl: "https://api.sprites.dev",
    apiToken: "test-token",
    fetch: fetchImplementation,
  });
}

describe("CreateCustomApiConnectorRequestSchema", () => {
  it("parses the provider request shape and defaults the auth prefix", () => {
    expect(CreateCustomApiConnectorRequestSchema.parse({
      name: "connector-1",
      baseApiUrl: "https://api.example.com",
      accessToken: "secret",
      testUrl: "https://api.example.com/health",
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
      },
    })).toEqual({
      name: "connector-1",
      baseApiUrl: "https://api.example.com",
      accessToken: "secret",
      testUrl: "https://api.example.com/health",
      authHeaderPrefix: "Bearer",
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
      },
    });
  });
});

describe("HttpSpriteConnectorsClient", () => {
  it("creates a custom API connector with its final access policy", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ connection: connectionPayload }, { status: 201 }),
    );

    const result = await client(fetchSpy).createCustomApiConnector({
      name: "cloude-session-abc123",
      baseApiUrl: "https://api.example.com",
      accessToken: "secret-token",
      testUrl: "https://api.example.com/health",
      authHeaderPrefix: "Bearer",
      description: "Cloude session connector",
      accessPolicy: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    });

    expect(result).toMatchObject({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.sprites.dev/v1/oauth/connections/custom_api");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "cloude-session-abc123",
      base_api_url: "https://api.example.com",
      access_token: "secret-token",
      test_url: "https://api.example.com/health",
      auth_method: "header",
      auth_header_prefix: "Bearer",
      description: "Cloude session connector",
      access_policy: {
        allow_all: false,
        sprite_labels: ["session:session-1"],
        allowed_endpoints: ["/health"],
      },
    });
  });

  it("maps the snake_case connection envelope to camelCase", async () => {
    const result = await client(async () => {
      return Response.json({ connections: [connectionPayload] });
    }).listConnectors();

    expect(result).toEqual({
      ok: true,
      value: [{
        id: "connection-1",
        provider: "custom_api",
        providerAccountName: "cloude-session-abc123",
        providerInfo: { base_api_url: "https://api.example.com" },
        accessPolicy: {
          allowAll: false,
          spriteLabels: ["session:session-1"],
        },
      }],
    });
  });

  it("rejects a list response that is not the documented envelope", async () => {
    const result = await client(async () => {
      return Response.json([connectionPayload]);
    }).listConnectors();

    expect(result).toEqual({
      ok: false,
      error: { code: "sprites_response_invalid", retryable: false },
    });
  });

  it("omits the access policy when Sprites reports none", async () => {
    const result = await client(async () => {
      return Response.json({
        connections: [{ ...connectionPayload, access_policy: {} }],
      });
    }).listConnectors();

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value[0]?.accessPolicy).toBeUndefined();
  });

  it("patches the access policy as snake_case and authenticates the request", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ connection: connectionPayload }),
    );

    const result = await client(fetchSpy).updateAccessPolicy("connection-1", {
      allowAll: false,
      spriteLabels: ["session:session-1"],
    });

    expect(result).toMatchObject({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.sprites.dev/v1/oauth/connections/connection-1");
    expect(init?.method).toBe("PATCH");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(init?.body))).toEqual({
      access_policy: {
        allow_all: false,
        sprite_labels: ["session:session-1"],
      },
    });
  });

  it("reads a missing connection as null so callers can confirm deletion", async () => {
    const result = await client(async () => {
      return new Response(null, { status: 404 });
    }).getConnector("connection-1");

    expect(result).toEqual({ ok: true, value: null });
  });

  it("accepts an empty 204 delete response", async () => {
    const result = await client(async () => {
      return new Response(null, { status: 204 });
    }).deleteConnector("connection-1");

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it.each([
    [401, "sprites_authentication_failed", false],
    [403, "sprites_authentication_failed", false],
    [429, "sprites_rate_limited", true],
    [500, "sprites_request_failed", true],
    [400, "sprites_request_failed", false],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    const result = await client(async () => {
      return new Response(null, { status });
    }).listConnectors();

    expect(result).toEqual({ ok: false, error: { code, retryable } });
  });

  it("treats a transport failure as retryable", async () => {
    const result = await client(async () => {
      throw new Error("network down");
    }).listConnectors();

    expect(result).toEqual({
      ok: false,
      error: { code: "sprites_request_failed", retryable: true },
    });
  });
});
