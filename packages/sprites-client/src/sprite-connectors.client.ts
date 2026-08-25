import { z } from "zod";
import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  CreateCustomApiConnectorRequest,
  SpriteConnector,
  SpriteConnectorsClient,
  SpritesRestError,
} from "./types";

const AccessPolicySchema = z.object({
  allow_all: z.boolean().optional(),
  sprite_labels: z.array(z.string()).optional(),
  name_prefix: z.string().optional(),
  allowed_endpoints: z.array(z.string()).optional(),
  blocked_endpoints: z.array(z.string()).optional(),
});

const ConnectorSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  provider_account_name: z.string().optional(),
  provider_info: z.record(z.string(), z.unknown()).optional(),
  access_policy: AccessPolicySchema.optional(),
});

const ConnectorResponseSchema = z.object({
  connection: ConnectorSchema,
});

// Sprites wraps single connections in `{ connection }`, and the collection in
// the matching `{ connections }` envelope. A bare array would fail the parse as
// `sprites_response_invalid` rather than being silently tolerated.
const ConnectorsResponseSchema = z.object({
  connections: z.array(ConnectorSchema),
});

type Fetch = typeof fetch;

interface HttpSpriteConnectorsClientOptions {
  apiUrl: string;
  apiToken: string;
  fetch?: Fetch;
}

export class HttpSpriteConnectorsClient implements SpriteConnectorsClient {
  private readonly apiUrl: string;
  private readonly apiToken: string;
  private readonly request: Fetch;

  constructor(options: HttpSpriteConnectorsClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/u, "");
    this.apiToken = options.apiToken;
    this.request = options.fetch ?? fetch.bind(globalThis);
  }

  async createCustomApiConnector(
    request: CreateCustomApiConnectorRequest,
  ): Promise<Result<SpriteConnector, SpritesRestError>> {
    const response = await this.fetch("/v1/oauth/connections/custom_api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: request.name,
        base_api_url: request.baseApiUrl,
        access_token: request.accessToken,
        test_url: request.testUrl,
        auth_method: "header",
        auth_header_prefix: request.authHeaderPrefix,
        ...(request.description === undefined ? {} : { description: request.description }),
        access_policy: mapAccessPolicyRequest(request.accessPolicy),
      }),
    });
    if (!response.ok) {
      return failure(response.error);
    }

    const parsed = ConnectorResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(mapConnector(parsed.data.connection));
  }

  async listConnectors(): Promise<Result<SpriteConnector[], SpritesRestError>> {
    const response = await this.fetch("/v1/oauth/connections", { method: "GET" });
    if (!response.ok) {
      return failure(response.error);
    }

    const parsed = ConnectorsResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(parsed.data.connections.map(mapConnector));
  }

  async updateAccessPolicy(
    connectorId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpriteConnector, SpritesRestError>> {
    const response = await this.fetch(connectorPath(connectorId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_policy: mapAccessPolicyRequest(policy) }),
    });
    if (!response.ok) {
      return failure(response.error);
    }

    const parsed = ConnectorResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(mapConnector(parsed.data.connection));
  }

  async getConnector(
    connectorId: string,
  ): Promise<Result<SpriteConnector | null, SpritesRestError>> {
    const response = await this.fetch(connectorPath(connectorId), { method: "GET" }, true);
    if (!response.ok) {
      return failure(response.error);
    }
    if (response.value === null) {
      return success(null);
    }

    const parsed = ConnectorResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(mapConnector(parsed.data.connection));
  }

  async deleteConnector(connectorId: string): Promise<Result<void, SpritesRestError>> {
    const response = await this.fetch(connectorPath(connectorId), { method: "DELETE" }, true);
    if (!response.ok) {
      return failure(response.error);
    }
    return success(undefined);
  }

  private async fetch(
    path: string,
    init: RequestInit,
    acceptNotFound = false,
  ): Promise<Result<unknown | null, SpritesRestError>> {
    let response: Response;
    try {
      response = await this.request(`${this.apiUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.apiToken}`,
        },
      });
    } catch {
      return failure({
        code: "sprites_request_failed",
        retryable: true,
      });
    }

    if (response.status === 404 && acceptNotFound) {
      return success(null);
    }
    if (!response.ok) {
      return failure(mapStatusError(response.status));
    }
    if (response.status === 204) {
      return success(null);
    }

    try {
      return success(await response.json());
    } catch {
      return failure(invalidResponse());
    }
  }
}

function connectorPath(connectorId: string): string {
  return `/v1/oauth/connections/${encodeURIComponent(connectorId)}`;
}

function mapAccessPolicyRequest(policy: AccessPolicy): Record<string, unknown> {
  return {
    allow_all: policy.allowAll,
    sprite_labels: policy.spriteLabels,
    ...(policy.namePrefix === undefined ? {} : { name_prefix: policy.namePrefix }),
    ...(policy.allowedEndpoints === undefined ? {} : { allowed_endpoints: policy.allowedEndpoints }),
    ...(policy.blockedEndpoints === undefined ? {} : { blocked_endpoints: policy.blockedEndpoints }),
  };
}

function mapConnector(connector: z.infer<typeof ConnectorSchema>): SpriteConnector {
  return {
    id: connector.id,
    provider: connector.provider,
    ...(connector.provider_account_name === undefined
      ? {}
      : { providerAccountName: connector.provider_account_name }),
    ...(connector.provider_info === undefined ? {} : { providerInfo: connector.provider_info }),
    ...(connector.access_policy?.allow_all === undefined
      ? {}
      : {
        accessPolicy: {
          allowAll: connector.access_policy.allow_all,
          spriteLabels: connector.access_policy.sprite_labels ?? [],
          ...(connector.access_policy.name_prefix === undefined
            ? {}
            : { namePrefix: connector.access_policy.name_prefix }),
          ...(connector.access_policy.allowed_endpoints === undefined
            ? {}
            : { allowedEndpoints: connector.access_policy.allowed_endpoints }),
          ...(connector.access_policy.blocked_endpoints === undefined
            ? {}
            : { blockedEndpoints: connector.access_policy.blocked_endpoints }),
        },
      }),
  };
}

function mapStatusError(status: number): SpritesRestError {
  if (status === 401 || status === 403) {
    return {
      code: "sprites_authentication_failed",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: "sprites_rate_limited",
      retryable: true,
    };
  }
  return {
    code: "sprites_request_failed",
    retryable: status >= 500,
  };
}

function invalidResponse(): SpritesRestError {
  return {
    code: "sprites_response_invalid",
    retryable: false,
  };
}

/**
 * Builds the connector gateway base URL a Sprite uses to call through a
 * Custom API connector. The gateway authenticates the calling Sprite from
 * Fly's request signature, evaluates the connector's access policy, injects
 * the stored credential, and forwards `base_api_url + <path after the id>`.
 *
 * @param spritesApiUrl - The Sprites API origin, e.g. `https://api.sprites.dev`.
 * @param gatewayConnectorId - The connector id returned by connector creation.
 * @returns The gateway base URL, without a trailing slash.
 */
export function buildConnectorGatewayUrl(
  spritesApiUrl: string,
  gatewayConnectorId: string,
): string {
  const base = spritesApiUrl.replace(/\/+$/, "");
  return `${base}/v1/gateway/custom_api/${gatewayConnectorId}`;
}
