import type { Migration, SqlFn, Repository } from "./repository.types";
import type { StartupToolchainCheckpoint } from "@/shared/types/startup-toolchain";

/**
 * Durable server-only session state — never synced to clients.
 * Tracks provisioning checkpoints so steps can be skipped on DO restart.
 */
export type ServerState = {
  /** True after handleInit has been called (sets sessionId, userId, etc.) */
  initialized: boolean;
  /** The DO's sessionId — null until handleInit is called (DO name bug workaround) */
  sessionId: string | null;
  /** The user id who owns the session */
  userId: string | null;
  /** Sprite VM name — null until sprite is created */
  spriteName: string | null;
  /** True after the repo has been cloned onto the sprite */
  repoCloned: boolean;
  /** Claude or Codex session ID for resuming agent state across restarts */
  agentSessionId: string | null;
  /** Sprite exec-session / process ID for the currently running vm-agent. */
  agentProcessId: number | null;
  /** Locally generated run id for correlating vm-agent lifecycle webhooks. */
  agentProcessRunId: string | null;
  /** User message id currently being handled by the agent, or null if idle. */
  activeUserMessageId: string | null;
  /** Provider runtime toolchain checkpoints for this Sprite. */
  startupToolchain: StartupToolchainCheckpoint | null;
  /** True after the selected environment startup script has completed, failed, or no-op'd. */
  startupScriptCompleted: boolean;
  /** True after the selected final network policy has been applied. */
  finalNetworkPolicyApplied: boolean;
  /** Gateway connection id of the session's internal connector, once minted. */
  sessionConnectorId: string | null;
  /** True when sprite creation applied the session labels, skipping label repair. */
  spriteLabelsApplied: boolean;
  /** True when post-clone git remotes were written against the connector gateway. */
  gitConfiguredViaConnector: boolean;
};

function defaultServerState(): ServerState {
  return {
    initialized: false,
    sessionId: null,
    userId: null,
    spriteName: null,
    repoCloned: false,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    startupScriptCompleted: false,
    finalNetworkPolicyApplied: false,
    sessionConnectorId: null,
    spriteLabelsApplied: false,
    gitConfiguredViaConnector: false,
  };
}

export class ServerStateRepository implements Repository {
  readonly name = "server_state";
  readonly migrations: ReadonlyArray<Migration> = [
    (sql) => {
      sql`
        CREATE TABLE IF NOT EXISTS server_state (
          id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL DEFAULT '{}'
        )
      `;
    },
  ];

  constructor(private sql: SqlFn) {}

  get(): ServerState {
    const rows = this.sql<{ state: string }>`SELECT state FROM server_state WHERE id = 'state'`;
    if (!rows[0]?.state) { return defaultServerState(); }
    // Merge on defaults so older persisted states without newer fields stay valid.
    return { ...defaultServerState(), ...JSON.parse(rows[0].state) } as ServerState;
  }

  update(partial: Partial<ServerState>): void {
    const current = this.get();
    const next = { ...current, ...partial };
    this.sql`INSERT OR REPLACE INTO server_state (id, state) VALUES ('state', ${JSON.stringify(next)})`;
  }
}
