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

const safeHeaderValue = z.string().max(128).refine((value) => !/[\r\n]/u.test(value), {
  message: "Header values cannot contain newlines",
});

export const CreateCustomApiConnectorRequestSchema = z.object({
  name: z.string().min(1).max(100).refine((value) => !/[\r\n]/u.test(value)),
  baseApiUrl: z.string().url(),
  accessToken: z.string().min(1).max(16_384),
  testUrl: z.string().url(),
  authHeaderPrefix: safeHeaderValue.default("Bearer"),
  description: z.string().max(1_024).optional(),
  accessPolicy: AccessPolicySchema,
}).strict();

export type CreateCustomApiConnectorRequest =
  z.infer<typeof CreateCustomApiConnectorRequestSchema>;

export interface SpriteConnector {
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

export interface SpriteConnectorsClient {
  createCustomApiConnector(
    request: CreateCustomApiConnectorRequest,
  ): Promise<Result<SpriteConnector, SpritesRestError>>;
  listConnectors(): Promise<Result<SpriteConnector[], SpritesRestError>>;
  updateAccessPolicy(
    connectorId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpriteConnector, SpritesRestError>>;
  getConnector(
    connectorId: string,
  ): Promise<Result<SpriteConnector | null, SpritesRestError>>;
  deleteConnector(connectorId: string): Promise<Result<void, SpritesRestError>>;
}
