import type { Result } from "@repo/shared";
import { z } from "zod";

export const AccessPolicySchema = z.object({
  allowAll: z.boolean(),
  spriteLabels: z.array(z.string()),
  namePrefix: z.string().optional(),
  allowedEndpoints: z.array(z.string()).optional(),
  blockedEndpoints: z.array(z.string()).optional(),
}).strict();

export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

export interface SpritesConnection {
  id: string;
  provider: string;
  providerAccountName?: string;
  providerInfo?: Record<string, unknown>;
  accessPolicy?: AccessPolicy;
}

export interface CreateCustomApiConnectionRequest {
  name: string;
  baseApiUrl: string;
  accessToken: string;
  testUrl: string;
  authHeaderPrefix: string;
  description?: string;
  accessPolicy: AccessPolicy;
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

export interface SpriteConnectorsClient {
  createCustomApiConnection(
    request: CreateCustomApiConnectionRequest,
  ): Promise<Result<SpritesConnection, SpritesRestError>>;
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
