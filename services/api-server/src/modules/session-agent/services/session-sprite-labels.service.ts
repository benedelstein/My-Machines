import type { Logger } from "@repo/shared";
import type { SpriteLifecycleClient, SpriteResponse } from "@repo/sprites-client";
import type { SessionSpriteLabelsContract } from
  "../types/runtime-migration-adopters.types";

export interface SessionSpriteLabelsServiceDeps {
  logger: Logger;
  spriteLifecycleClient: SpriteLifecycleClient;
  getSpriteIdentity: () => {
    readonly sessionId: string | null;
    readonly spriteName: string | null;
  };
  takeFreshSpriteSnapshot: () => SpriteResponse | null;
}

/** Builds the exact label set owned by a session Sprite. */
export function buildSessionSpriteLabels(
  sessionId: string,
  sourceEnvironmentId: string | null,
): string[] {
  const labels = [`session:${sessionId}`];
  if (sourceEnvironmentId) {
    labels.push(`env:${sourceEnvironmentId}`);
  }
  return labels;
}

/** Owns reconciliation of the complete label set on a session's Sprite. */
export class SessionSpriteLabelsService {
  private readonly logger: Logger;
  private readonly spriteLifecycleClient: SpriteLifecycleClient;
  private readonly getSpriteIdentity: SessionSpriteLabelsServiceDeps["getSpriteIdentity"];
  private readonly takeFreshSpriteSnapshot: SessionSpriteLabelsServiceDeps["takeFreshSpriteSnapshot"];

  constructor(deps: SessionSpriteLabelsServiceDeps) {
    this.logger = deps.logger.scope("session-sprite-labels-service");
    this.spriteLifecycleClient = deps.spriteLifecycleClient;
    this.getSpriteIdentity = deps.getSpriteIdentity;
    this.takeFreshSpriteSnapshot = deps.takeFreshSpriteSnapshot;
  }

  /** Replaces and verifies the Sprite's complete label set when it differs. */
  async reconcile(contract: SessionSpriteLabelsContract): Promise<void> {
    const { sessionId, spriteName } = this.getSpriteIdentity();
    if (!sessionId || !spriteName) {
      throw new Error("Session Sprite label prerequisites are missing");
    }

    const freshSprite = this.takeFreshSpriteSnapshot();
    const existing = freshSprite?.name === spriteName && Array.isArray(freshSprite.labels)
      ? freshSprite.labels
      : (await this.spriteLifecycleClient.getSprite(spriteName)).labels;
    if (!existing) {
      this.logger.error("Sprite labels were omitted from the read response", {
        fields: { sessionId, spriteName },
      });
      throw new Error("Sprite labels were omitted from the read response");
    }
    if (labelSetsEqual(existing, contract.labels)) {
      return;
    }

    this.logger.info("Sprite labels are outdated, updating", {
      fields: {
        sessionId,
        spriteName,
        desired: contract.labels.join(", "),
        existing: existing.join(", "),
      },
    });
    const updated = await this.spriteLifecycleClient.updateSprite(spriteName, {
      labels: [...contract.labels],
    });
    if (!updated.labels || !labelSetsEqual(updated.labels, contract.labels)) {
      this.logger.warn("Sprite labels differ after update", {
        fields: {
          sessionId,
          spriteName,
          desired: [...contract.labels],
          reported: updated.labels ?? null,
        },
      });
      throw new Error("Sprite label update did not persist the desired label set");
    }
  }
}

function labelSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}
