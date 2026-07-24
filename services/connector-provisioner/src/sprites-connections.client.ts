import { z } from "zod";
import type {
  AccessPolicy,
  Result,
  SpritesConnection,
  SpritesConnectionsClient,
  SpritesRestError,
} from "./types";
import { failure, success } from "./types";

const AccessPolicySchema = z.object({
  allow_all: z.boolean().optional(),
  sprite_labels: z.array(z.string()).optional(),
  name_prefix: z.string().optional(),
  allowed_endpoints: z.array(z.string()).optional(),
  blocked_endpoints: z.array(z.string()).optional(),
});

const ConnectionSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  provider_account_name: z.string().optional(),
  provider_info: z.record(z.string(), z.unknown()).optional(),
  access_policy: AccessPolicySchema.optional(),
});

const ConnectionResponseSchema = z.object({
  connection: ConnectionSchema,
});

const ConnectionsResponseSchema = z.union([
  z.object({ connections: z.array(ConnectionSchema) }),
  z.array(ConnectionSchema),
]);

type Fetch = typeof fetch;

interface SpritesConnectionsClientOptions {
  apiUrl: string;
  apiToken: string;
  fetch?: Fetch;
}

export class HttpSpritesConnectionsClient implements SpritesConnectionsClient {
  private readonly apiUrl: string;
  private readonly apiToken: string;
  private readonly request: Fetch;

  constructor(options: SpritesConnectionsClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/u, "");
    this.apiToken = options.apiToken;
    this.request = options.fetch ?? fetch.bind(globalThis);
  }

  async listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>> {
    const response = await this.fetch("/v1/oauth/connections", { method: "GET" });
    if (!response.ok) {
      return failure(response.error);
    }

    const parsed = ConnectionsResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    const connections = Array.isArray(parsed.data) ? parsed.data : parsed.data.connections;
    return success(connections.map(mapConnection));
  }

  async updateAccessPolicy(
    connectionId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpritesConnection, SpritesRestError>> {
    const response = await this.fetch(connectionPath(connectionId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_policy: mapAccessPolicyRequest(policy) }),
    });
    if (!response.ok) {
      return failure(response.error);
    }

    const parsed = ConnectionResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(mapConnection(parsed.data.connection));
  }

  async getConnection(
    connectionId: string,
  ): Promise<Result<SpritesConnection | null, SpritesRestError>> {
    const response = await this.fetch(connectionPath(connectionId), { method: "GET" }, true);
    if (!response.ok) {
      return failure(response.error);
    }
    if (response.value === null) {
      return success(null);
    }

    const parsed = ConnectionResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      return failure(invalidResponse());
    }

    return success(mapConnection(parsed.data.connection));
  }

  async deleteConnection(connectionId: string): Promise<Result<void, SpritesRestError>> {
    const response = await this.fetch(connectionPath(connectionId), { method: "DELETE" }, true);
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

function connectionPath(connectionId: string): string {
  return `/v1/oauth/connections/${encodeURIComponent(connectionId)}`;
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

function mapConnection(connection: z.infer<typeof ConnectionSchema>): SpritesConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    ...(connection.provider_account_name === undefined
      ? {}
      : { providerAccountName: connection.provider_account_name }),
    ...(connection.provider_info === undefined ? {} : { providerInfo: connection.provider_info }),
    ...(connection.access_policy?.allow_all === undefined
      ? {}
      : {
        accessPolicy: {
          allowAll: connection.access_policy.allow_all,
          spriteLabels: connection.access_policy.sprite_labels ?? [],
          ...(connection.access_policy.name_prefix === undefined
            ? {}
            : { namePrefix: connection.access_policy.name_prefix }),
          ...(connection.access_policy.allowed_endpoints === undefined
            ? {}
            : { allowedEndpoints: connection.access_policy.allowed_endpoints }),
          ...(connection.access_policy.blocked_endpoints === undefined
            ? {}
            : { blockedEndpoints: connection.access_policy.blocked_endpoints }),
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
