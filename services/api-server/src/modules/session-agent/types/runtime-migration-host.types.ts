import type { Logger, ProviderId } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { StartupToolchainCheckpoint } from "./startup-toolchain.types";

/** The slice of ServerState runtime migrations may read or write. */
export interface RuntimeMigrationServerState {
  readonly activeUserMessageId: string | null;
  readonly spriteName: string | null;
  readonly startupToolchain: StartupToolchainCheckpoint | null;
}

/** The slice of ClientState runtime migrations may read. */
export interface RuntimeMigrationClientState {
  readonly agentSettings: { readonly provider: ProviderId };
}

/** Env values a runtime migration may read while building its own context. */
export interface RuntimeMigrationHostEnv {
  readonly CODEX_MIN_VERSION?: string;
}

/**
 * Session-scoped capabilities handed to every runtime migration.
 *
 * The coordinator itself reads only `getServerState().activeUserMessageId` and
 * `isTeardownStarted()`. Everything else exists so each definition can build
 * its own typed context in `buildContext`, keeping adopter-specific
 * dependencies out of the engine. Widen the state slices above as adopters
 * need more — that keeps the migration surface explicit rather than handing
 * every migration the whole session.
 */
export interface RuntimeMigrationHost {
  readonly getServerState: () => RuntimeMigrationServerState;
  readonly getClientState: () => RuntimeMigrationClientState;
  readonly updateServerState: (partial: Partial<RuntimeMigrationServerState>) => void;
  readonly isTeardownStarted: () => boolean;
  /** Client for the session's current Sprite. Throws before provisioning. */
  readonly createSpriteClient: () => WorkersSpriteClient;
  readonly env: RuntimeMigrationHostEnv;
  readonly logger: Logger;
}
