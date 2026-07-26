import { z } from "zod";
import type { Session} from "@fly/sprites";
import { SpritesClient } from "@fly/sprites";
import type { Logger } from "@repo/shared";

// =============================================================================
// Zod Schemas
// =============================================================================

export const SpriteStatus = z.enum(["cold", "warm", "running"]);
export type SpriteStatus = z.infer<typeof SpriteStatus>;

export const SpriteResponse = z.object({
  id: z.string().optional(),
  name: z.string(),
  status: z.enum(["cold", "warm", "running"]).optional(),
  url: z.string().optional(),
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
  image: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type CreateSpriteRequest = z.infer<typeof CreateSpriteRequest>;


export interface SpritesClientConfig {
  apiKey: string;
  timeout?: number;
  logger: Logger;
}

/**
 * SpriteLifecycleClient - Wraps @fly/sprites for sprite lifecycle management
 * Uses HTTP-based operations (create/delete/get) which work in Workers
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
    const sprite = await this.spritesClient.createSprite(request.name, config);
    this.logger.info("Created sprite", {
      fields: {
        spriteName: sprite.name,
        spriteId: sprite.id ?? null,
        durationMs: Date.now() - startedAt,
      },
    });
    return SpriteResponse.parse({
      id: sprite.id,
      name: sprite.name,
      status: sprite.status,
      createdAt: sprite.createdAt?.toISOString(),
      updatedAt: sprite.updatedAt?.toISOString(),
    });
  }

  async getSprite(name: string): Promise<SpriteResponse> {
    const sprite = await this.spritesClient.getSprite(name);
    return SpriteResponse.parse({
      id: sprite.id,
      name: sprite.name,
      status: sprite.status,
      url: "",
      createdAt: sprite.createdAt,
      updatedAt: sprite.updatedAt,
    });
  }

  async deleteSprite(name: string): Promise<void> {
    await this.spritesClient.deleteSprite(name);
  }

  async listSessions(name: string): Promise<Array<Session>> {
    const sessions = await this.spritesClient.sprite(name).listSessions();
    return sessions;
  }
}
