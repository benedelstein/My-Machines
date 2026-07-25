import type { Result } from "@repo/shared";

export interface AccessPolicy {
  allowAll: boolean;
  spriteLabels: string[];
  namePrefix?: string;
  allowedEndpoints?: string[];
  blockedEndpoints?: string[];
}

export interface SpritesConnection {
  id: string;
  provider: string;
  providerAccountName?: string;
  providerInfo?: Record<string, unknown>;
  accessPolicy?: AccessPolicy;
}

export type SpritesRestErrorCode =
  | "sprites_authentication_failed"
  | "sprites_rate_limited"
  | "sprites_request_failed"
  | "sprites_response_invalid";

export interface SpritesRestError {
  code: SpritesRestErrorCode;
  retryable: boolean;
}

export interface SpritesConnectionsClient {
  listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>>;
  updateAccessPolicy(
    connectionId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpritesConnection, SpritesRestError>>;
  getConnection(
    connectionId: string,
  ): Promise<Result<SpritesConnection | null, SpritesRestError>>;
  deleteConnection(connectionId: string): Promise<Result<void, SpritesRestError>>;
}
