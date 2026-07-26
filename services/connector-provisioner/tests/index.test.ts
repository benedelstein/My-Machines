import type { BrowserWorker } from "@cloudflare/playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, type Env } from "../src/index";

function handleRequest(request: Request, environment: Env): Promise<Response> {
  return Promise.resolve(app.fetch(request, environment));
}

const baseEnvironment: Env = {
  BROWSER: {} as BrowserWorker,
  CONNECTOR_PROVISIONER_BEARER_TOKEN: "provisioner-secret",
  SPRITES_API_KEY: "sprites-secret",
  SPRITES_API_URL: "https://api.sprites.dev",
  SPRITES_DASHBOARD_STORAGE_STATE: "",
  SPRITES_DASHBOARD_URL: "",
  SPRITES_ORG_SLUG: "",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connector provisioner HTTP boundary", () => {
  it("rejects protected operations without its bearer", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(
      new Request("https://provisioner.test/v1/connectors/example", {
        method: "DELETE",
      }),
      baseEnvironment,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deletes a session-labelled connector without requiring dashboard credentials", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(sessionConnectorResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(deleteRequest(), baseEnvironment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connector: {
        gatewayConnectionId: "gateway-id",
        deleted: true,
      },
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://api.sprites.dev/v1/oauth/connections/gateway-id",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://api.sprites.dev/v1/oauth/connections/gateway-id",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://api.sprites.dev/v1/oauth/connections/gateway-id",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("refuses to delete a connector without session-only labels", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(sessionConnectorResponse({
      sprite_labels: ["env:environment-1"],
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(deleteRequest(), baseEnvironment);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "connector_delete_refused" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete an unscoped connector", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(sessionConnectorResponse({
      allow_all: true,
      sprite_labels: ["session:session-1"],
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(deleteRequest(), baseEnvironment);

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the connector to delete does not exist", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(deleteRequest(), baseEnvironment);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "connector_not_found" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a mint request with an invalid body", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(
      new Request("https://provisioner.test/v1/connectors/mint", {
        method: "POST",
        headers: {
          "Authorization": "Bearer provisioner-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "missing-everything-else" }),
      }),
      mintCapableEnvironment(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest(
      new Request("https://provisioner.test/v2/unknown"),
      baseEnvironment,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found" },
    });
  });
});

function mintCapableEnvironment(): Env {
  return {
    ...baseEnvironment,
    BROWSER: { fetch: () => Promise.resolve(new Response(null)) } as BrowserWorker,
    SPRITES_DASHBOARD_STORAGE_STATE: "{}",
    SPRITES_DASHBOARD_URL: "https://dashboard.sprites.dev",
    SPRITES_ORG_SLUG: "example-org",
  };
}

function deleteRequest(): Request {
  return new Request("https://provisioner.test/v1/connectors/gateway-id", {
    method: "DELETE",
    headers: {
      Authorization: "Bearer provisioner-secret",
    },
  });
}

function sessionConnectorResponse(accessPolicy: Record<string, unknown> = {}): Response {
  return Response.json({
    connection: {
      id: "gateway-id",
      provider: "custom_api",
      access_policy: {
        allow_all: false,
        sprite_labels: ["session:session-1"],
        ...accessPolicy,
      },
    },
  });
}
