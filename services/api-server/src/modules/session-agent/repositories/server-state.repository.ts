import type { Migration, SqlFn, Repository } from "./repository.types";
import {
  defaultServerState,
  type ServerState,
} from "@/modules/session-agent/types/server-state.types";

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
    const parsed = JSON.parse(rows[0].state) as Partial<ServerState> & {
      gitConfiguredViaConnector?: boolean;
    };
    const { gitConfiguredViaConnector: _legacyConnectorFlag, ...persisted } = parsed;
    return { ...defaultServerState(), ...persisted };
  }

  update(partial: Partial<ServerState>): void {
    const current = this.get();
    const next = { ...current, ...partial };
    this.sql`INSERT OR REPLACE INTO server_state (id, state) VALUES ('state', ${JSON.stringify(next)})`;
  }
}
