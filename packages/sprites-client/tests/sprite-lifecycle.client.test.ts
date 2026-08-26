import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "@repo/shared";
import { SpriteLifecycleClient } from "../src/sprite-lifecycle.client";

const spritesSdk = vi.hoisted(() => ({
  updateSprite: vi.fn(),
}));

vi.mock("@fly/sprites", () => ({
  SpritesClient: class {
    updateSprite = spritesSdk.updateSprite;
  },
}));

const logger = new ConsoleLogger({ format: "pretty" }, "sprite-lifecycle.client.test.ts");

describe("SpriteLifecycleClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a partial update and returns the normalized Sprite response", async () => {
    spritesSdk.updateSprite.mockResolvedValue({
      id: "sprite-id",
      name: "sprite-1",
      status: "cold",
      url: "https://sprite-1.sprites.app",
      urlSettings: { auth: "public" },
      labels: ["session:session-1"],
      createdAt: new Date("2026-08-19T00:00:00.000Z"),
      updatedAt: new Date("2026-08-19T01:00:00.000Z"),
    });
    const client = new SpriteLifecycleClient({ apiKey: "sprites-key", logger });

    await expect(client.updateSprite("sprite-1", {
      labels: ["session:session-1"],
    })).resolves.toEqual({
      id: "sprite-id",
      name: "sprite-1",
      status: "cold",
      url: "https://sprite-1.sprites.app",
      urlSettings: { auth: "public" },
      labels: ["session:session-1"],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T01:00:00.000Z",
    });
    expect(spritesSdk.updateSprite).toHaveBeenCalledWith("sprite-1", {
      labels: ["session:session-1"],
    });
  });

  it("rejects an update without mutable fields before calling the SDK", async () => {
    const client = new SpriteLifecycleClient({ apiKey: "sprites-key", logger });

    await expect(client.updateSprite("sprite-1", {})).rejects.toThrow(
      "urlSettings or labels is required",
    );
    expect(spritesSdk.updateSprite).not.toHaveBeenCalled();
  });
});
