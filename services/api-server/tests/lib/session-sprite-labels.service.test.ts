import { describe, expect, it, vi } from "vitest";
import type { SpriteLifecycleClient, SpriteResponse } from "@repo/sprites-client";
import type { SessionSpriteLabelsContract } from
  "../../src/modules/session-agent/types/runtime-migration-adopters.types";
import {
  buildSessionSpriteLabels,
  SessionSpriteLabelsService,
} from "../../src/modules/session-agent/services/session-sprite-labels.service";
import { createTestLogger } from "./test-logger";

const desiredContract: SessionSpriteLabelsContract = {
  contractSchema: 1,
  labels: ["session:session-1", "env:environment-1"],
};

function createService(args: {
  freshSpriteSnapshot?: SpriteResponse | null;
  readLabels?: string[];
  updateLabels?: string[];
} = {}) {
  let freshSpriteSnapshot = args.freshSpriteSnapshot ?? null;
  const takeFreshSpriteSnapshot = vi.fn(() => {
    const snapshot = freshSpriteSnapshot;
    freshSpriteSnapshot = null;
    return snapshot;
  });
  const getSprite = vi.fn(async () => ({
    name: "sprite-1",
    labels: args.readLabels ?? [...desiredContract.labels],
  }));
  const updateSprite = vi.fn(async (_spriteName: string, request: { labels?: string[] }) => ({
    name: "sprite-1",
    labels: args.updateLabels ?? request.labels,
  }));
  const spriteLifecycleClient = {
    getSprite,
    updateSprite,
  } as unknown as SpriteLifecycleClient;
  const service = new SessionSpriteLabelsService({
    logger: createTestLogger(),
    spriteLifecycleClient,
    getSpriteIdentity: () => ({
      sessionId: "session-1",
      spriteName: "sprite-1",
    }),
    takeFreshSpriteSnapshot,
  });

  return { service, getSprite, updateSprite, takeFreshSpriteSnapshot };
}

describe("buildSessionSpriteLabels", () => {
  it("derives the exact labels from session and persisted environment identity", () => {
    expect(buildSessionSpriteLabels("session-1", null)).toEqual(["session:session-1"]);
    expect(buildSessionSpriteLabels("session-1", "environment-1")).toEqual([
      "session:session-1",
      "env:environment-1",
    ]);
  });
});

describe("SessionSpriteLabelsService.reconcile", () => {
  it("uses a matching fresh Sprite snapshot without an immediate GET", async () => {
    const fixture = createService({
      freshSpriteSnapshot: {
        name: "sprite-1",
        labels: [...desiredContract.labels],
      },
    });

    await fixture.service.reconcile(desiredContract);

    expect(fixture.takeFreshSpriteSnapshot).toHaveBeenCalledOnce();
    expect(fixture.getSprite).not.toHaveBeenCalled();
  });

  it("falls back to GET when the fresh snapshot cannot supply labels", async () => {
    const fixture = createService({
      freshSpriteSnapshot: { name: "different-sprite", labels: ["unrelated"] },
    });

    await fixture.service.reconcile(desiredContract);

    expect(fixture.getSprite).toHaveBeenCalledWith("sprite-1");
  });

  it("does not update an unchanged label set", async () => {
    const fixture = createService({
      readLabels: [...desiredContract.labels].reverse(),
    });

    await fixture.service.reconcile(desiredContract);

    expect(fixture.updateSprite).not.toHaveBeenCalled();
  });

  it("replaces a changed label set with the exact desired array", async () => {
    const fixture = createService({
      readLabels: ["session:stale", "unrelated"],
    });

    await fixture.service.reconcile(desiredContract);

    expect(fixture.updateSprite).toHaveBeenCalledWith("sprite-1", {
      labels: ["session:session-1", "env:environment-1"],
    });
  });

  it("fails when labels are omitted from the authoritative read", async () => {
    const fixture = createService();
    fixture.getSprite.mockResolvedValue({ name: "sprite-1" });

    await expect(fixture.service.reconcile(desiredContract)).rejects.toThrow(
      "Sprite labels were omitted from the read response",
    );

    expect(fixture.updateSprite).not.toHaveBeenCalled();
  });

  it("fails when the update response does not verify the exact desired set", async () => {
    const fixture = createService({
      readLabels: ["unrelated"],
      updateLabels: ["session:session-1", "unrelated"],
    });

    await expect(fixture.service.reconcile(desiredContract)).rejects.toThrow(
      "Sprite label update did not persist the desired label set",
    );
  });
});
