import { describe, expect, it } from "vitest";
import { HttpSpritesConnectionsClient } from "../src/sprites-connections.client";

describe("HttpSpritesConnectionsClient", () => {
  it("accepts connections with an empty access policy", async () => {
    const client = new HttpSpritesConnectionsClient({
      apiUrl: "https://api.sprites.dev",
      apiToken: "test-token",
      fetch: async () => {
        return new Response(JSON.stringify({
          connections: [{
            id: "connection-1",
            provider: "github",
            provider_account_name: "Test account",
            provider_info: {},
            access_policy: {},
          }],
        }));
      },
    });

    const result = await client.listConnections();

    expect(result).toEqual({
      ok: true,
      value: [{
        id: "connection-1",
        provider: "github",
        providerAccountName: "Test account",
        providerInfo: {},
      }],
    });
  });
});
