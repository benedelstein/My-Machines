import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookClient } from "../src/lib/webhook-client";

describe("WebhookClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function requestHeaders(): Record<string, string> {
    return fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
  }

  it("sends a bearer token when one is configured", async () => {
    await new WebhookClient("https://worker.test/internal/session/s1", "token-1")
      .post("/events", { event: { type: "ready" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.test/internal/session/s1/events",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestHeaders().Authorization).toBe("Bearer token-1");
  });

  it("omits the Authorization header in gateway mode", async () => {
    const gatewayBase = "https://api.sprites.dev/v1/gateway/custom_api/conn-1";
    await new WebhookClient(`${gatewayBase}/internal/session/s1`, null)
      .post("/chunks", { userMessageId: "m1", chunks: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${gatewayBase}/internal/session/s1/chunks`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestHeaders()).not.toHaveProperty("Authorization");
    expect(requestHeaders()["Content-Type"]).toBe("application/json");
  });

  it("drops the post after a non-retryable status without retrying", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    await new WebhookClient("https://worker.test/internal/session/s1", null)
      .post("/events", { event: { type: "ready" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
