import type { Logger, ProviderId } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { ServerState } from "./server-state.types";

/**
 * The slice of ServerState runtime migrations may read or write. Widen this
 * union as adopters need more — it keeps the migration surface explicit
 * instead of handing every migration the whole session.
 */
export type RuntimeMigrationServerState = Pick<
  ServerState,
  "activeUserMessageId" | "spriteName" | "startupToolchain"
>;

/** The slice of ClientState runtime migrations may read. */
export interface RuntimeMigrationClientState {
  readonly agentSettings: { readonly provider: ProviderId };
}

/** Env values a runtime migration may read while building its own context. */
export interface RuntimeMigrationEnv {
  readonly CODEX_MIN_VERSION?: string;
}

/**
 * Session-scoped capabilities handed to every runtime migration.
 *
 * The coordinator itself reads only `getServerState().activeUserMessageId` and
 * `isTeardownStarted()`. Everything else exists so each definition can build
 * its own typed context in `buildContext`, keeping adopter-specific
 * dependencies out of the engine.
 */
export interface RuntimeMigrationDependencies {
  readonly getServerState: () => RuntimeMigrationServerState;
  readonly getClientState: () => RuntimeMigrationClientState;
  readonly updateServerState: (partial: Partial<RuntimeMigrationServerState>) => void;
  readonly isTeardownStarted: () => boolean;
  /** Client for the session's current Sprite. Throws before provisioning. */
  readonly createSpriteClient: () => WorkersSpriteClient;
  readonly env: RuntimeMigrationEnv;
  readonly logger: Logger;
  // add other dependencies as needed
}
