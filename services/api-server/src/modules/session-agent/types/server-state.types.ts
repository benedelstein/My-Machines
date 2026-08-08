import { z } from "zod";
import { StartupToolchainCheckpoint } from "./startup-toolchain.types";

/**
 * Durable server-only session state — never synced to clients.
 * Tracks provisioning checkpoints so steps can be skipped on DO restart.
 *
 * This schema is the single source of truth for the shape; `ServerState` is
 * derived from it. The repository's `get()` deliberately merges onto defaults
 * without parsing,
 * so a row it cannot validate never bricks DO construction. A future surgical
 * migration that transforms this row should validate its result against this
 * schema, where a throw correctly rolls the transaction back.
 */
export const ServerStateSchema = z.object({
  /** True after handleInit has been called (sets sessionId, userId, etc.) */
  initialized: z.boolean(),
  /** Durable guard preventing new runtime migration attempts once teardown begins. */
  teardownStarted: z.boolean(),
  /** The DO's sessionId — null until handleInit is called (DO name bug workaround) */
  sessionId: z.string().nullable(),
  /** The user id who owns the session */
  userId: z.string().nullable(),
  /** Sprite VM name — null until sprite is created */
  spriteName: z.string().nullable(),
  /** True after the repo has been cloned onto the sprite */
  repoCloned: z.boolean(),
  /** Claude or Codex session ID for resuming agent state across restarts */
  agentSessionId: z.string().nullable(),
  /** Sprite exec-session / process ID for the currently running vm-agent. */
  agentProcessId: z.number().nullable(),
  /** Locally generated run id for correlating vm-agent lifecycle webhooks. */
  agentProcessRunId: z.string().nullable(),
  /** User message id currently being handled by the agent, or null if idle. */
  activeUserMessageId: z.string().nullable(),
  /** Durable handoff state between synchronous turn claim and asynchronous dispatch. */
  activeTurnDispatchStatus: z.enum(["claimed", "dispatched"]).nullable(),
  /** Provider runtime toolchain checkpoints for this Sprite. */
  startupToolchain: StartupToolchainCheckpoint.nullable(),
  /** True after the selected environment startup script has completed, failed, or no-op'd. */
  startupScriptCompleted: z.boolean(),
  /** True after the selected final network policy has been applied. */
  finalNetworkPolicyApplied: z.boolean(),
  /** Gateway connection id of the session's internal connector, once minted. */
  sessionConnectorId: z.string().nullable(),
  /** True when sprite creation applied the session labels, skipping label repair. */
  spriteLabelsApplied: z.boolean(),
  /** Authentication mode used by post-clone Git proxy requests. */
  gitAuthMode: z.enum(["legacy_secret", "ephemeral_token"]),
});

export type ServerState = z.infer<typeof ServerStateSchema>;

export function defaultServerState(): ServerState {
  return {
    initialized: false,
    teardownStarted: false,
    sessionId: null,
    userId: null,
    spriteName: null,
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    activeTurnDispatchStatus: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    sessionConnectorId: null,
    spriteLabelsApplied: false,
    gitAuthMode: "legacy_secret",
  };
}
