import type { BrowserWorker } from "@cloudflare/playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../src/index";

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

  it("deletes without requiring dashboard credentials", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleRequest(
      new Request("https://provisioner.test/v1/connectors/gateway-id", {
        method: "DELETE",
        headers: {
          Authorization: "Bearer provisioner-secret",
        },
      }),
      baseEnvironment,
    );

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
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://api.sprites.dev/v1/oauth/connections/gateway-id",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
