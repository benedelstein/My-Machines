/**
 * Builds the connector gateway base URL a Sprite uses to call through a
 * Custom API connector. The gateway authenticates the calling Sprite from
 * Fly's request signature, evaluates the connector's access policy, injects
 * the stored credential, and forwards `base_api_url + <path after the id>`.
 *
 * @param spritesApiUrl - The Sprites API origin, e.g. `https://api.sprites.dev`.
 * @param gatewayConnectionId - The connection id returned by connector creation.
 * @returns The gateway base URL, without a trailing slash.
 */
export function buildConnectorGatewayUrl(
  spritesApiUrl: string,
  gatewayConnectionId: string,
): string {
  const base = spritesApiUrl.replace(/\/+$/, "");
  return `${base}/v1/gateway/custom_api/${gatewayConnectionId}`;
}
