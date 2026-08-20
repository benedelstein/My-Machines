import { z } from "zod";
import type { Session, Sprite } from "@fly/sprites";
import { SpritesClient } from "@fly/sprites";
import type { Logger } from "@repo/shared";

// =============================================================================
// Zod Schemas
// =============================================================================

export const SpriteStatus = z.enum(["cold", "warm", "running"]);
export type SpriteStatus = z.infer<typeof SpriteStatus>;

export const SpriteUrlSettings = z.object({
  auth: z.enum(["public", "sprite"]),
  privateAccess: z.enum(["admins", "org_users"]).optional(),
});
export type SpriteUrlSettings = z.infer<typeof SpriteUrlSettings>;

export const SpriteResponse = z.object({
  id: z.string().optional(),
  name: z.string(),
  status: z.enum(["cold", "warm", "running"]).optional(),
  url: z.string().optional(),
  urlSettings: SpriteUrlSettings.optional(),
  labels: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SpriteResponse = z.infer<typeof SpriteResponse>;

export const CreateSpriteRequest = z.object({
  name: z.string(),
  config: z
    .object({
      ramMB: z.number().optional(),
      cpus: z.number().optional(),
      storageGB: z.number().optional(),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
  image: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type CreateSpriteRequest = z.infer<typeof CreateSpriteRequest>;

export const UpdateSpriteRequest = z
  .object({
    urlSettings: SpriteUrlSettings.optional(),
    labels: z.array(z.string()).optional(),
  })
  .refine(
    (request) => request.urlSettings !== undefined || request.labels !== undefined,
    { message: "urlSettings or labels is required" },
  );
export type UpdateSpriteRequest = z.infer<typeof UpdateSpriteRequest>;

export interface SpritesClientConfig {
  apiKey: string;
  timeout?: number;
  logger: Logger;
}

/**
 * SpriteLifecycleClient - Wraps @fly/sprites for sprite lifecycle management
 * Uses HTTP-based operations (create/delete/get) which work in Workers
 * other operations dont work in workers so we have our own implementation.
 */
export class SpriteLifecycleClient {
  private spritesClient: SpritesClient;
  private logger: Logger;

  constructor(config: SpritesClientConfig) {
    this.spritesClient = new SpritesClient(config.apiKey, {
      timeout: config.timeout,
    });
    this.logger = config.logger;
  }

  async createSprite(request: CreateSpriteRequest): Promise<SpriteResponse> {
    const config = request.config
      ? {
          ramMB: request.config.ramMB,
          cpus: request.config.cpus,
          storageGB: request.config.storageGB,
        }
      : undefined;
    const startedAt = Date.now();
    const sprite = await this.spritesClient.createSprite(request.name, {
      config,
      labels: request.labels,
    });
    this.logger.info("Created sprite", {
      fields: {
        spriteName: sprite.name,
        spriteId: sprite.id ?? null,
        labels: sprite.labels ?? null,
        durationMs: Date.now() - startedAt,
      },
    });
    return toSpriteResponse(sprite);
  }

  async getSprite(name: string): Promise<SpriteResponse> {
    const sprite = await this.spritesClient.getSprite(name);
    return toSpriteResponse(sprite);
  }

  /**
   * Partially updates a Sprite's mutable settings.
   *
   * @param name - The Sprite name.
   * @param request - Mutable fields to update. Omitted top-level fields remain unchanged.
   * @returns The updated Sprite returned by the provider.
   */
  async updateSprite(name: string, request: UpdateSpriteRequest): Promise<SpriteResponse> {
    const parsedRequest = UpdateSpriteRequest.parse(request);
    const sprite = await this.spritesClient.updateSprite(name, parsedRequest);
    this.logger.info("Updated sprite", {
      fields: {
        spriteName: name,
        updatedLabels: parsedRequest.labels !== undefined,
        updatedUrlSettings: parsedRequest.urlSettings !== undefined,
      },
    });
    return toSpriteResponse(sprite);
  }

  async deleteSprite(name: string): Promise<void> {
    await this.spritesClient.deleteSprite(name);
  }

  async listSessions(name: string): Promise<Array<Session>> {
    const sessions = await this.spritesClient.sprite(name).listSessions();
    return sessions;
  }
}

function toSpriteResponse(sprite: Sprite): SpriteResponse {
  return SpriteResponse.parse({
    id: sprite.id,
    name: sprite.name,
    status: sprite.status,
    url: sprite.url,
    urlSettings: sprite.urlSettings,
    labels: sprite.labels,
    createdAt: sprite.createdAt?.toISOString(),
    updatedAt: sprite.updatedAt?.toISOString(),
  });
}
