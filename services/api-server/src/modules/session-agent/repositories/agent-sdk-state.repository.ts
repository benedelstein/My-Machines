import type { Migration, Repository } from "./repository.types";

/**
 * Storage contract of the pinned Agents SDK (`agents` package): client state is
 * persisted as one JSON row in `cf_agents_state` keyed by `cf_state_row_id`,
 * created by the SDK constructor and hydrated lazily on first `this.state`
 * access. Verified against the real SDK by
 * `tests/lib/agents-sdk-state-contract.test.ts`.
 */
export const AGENT_SDK_STATE_TABLE = "cf_agents_state";
export const AGENT_SDK_STATE_ROW_ID = "cf_state_row_id";

/**
 * Migration-only adapter for the Agents SDK-owned client-state row.
 *
 * This repository exists so `migrateAll()` can reach the `cf_agents_state` row
 * at the pre-hydration boundary — before the SDK hydrates `this.state`, before
 * services that read client state are constructed, and before any socket
 * snapshot. Normal client-state reads, writes, and broadcasts must keep going
 * through the Agents SDK (`this.state` / `setState`); nothing outside
 * constructor-time migration may touch this table directly.
 *
 * To add a migration, append a step to `migrations`
 * that reads the row, transforms only the fields that changed, validates the
 * result with `ClientStateSchema`, and writes it back:
 *
 * ```ts
 * (sql) => {
 *   const rows = sql<{ state: string | null }>`
 *     SELECT state FROM cf_agents_state WHERE id = ${AGENT_SDK_STATE_ROW_ID}
 *   `;
 *   const stored = rows[0]?.state;
 *   // An absent row is a no-op: the SDK initializes current-shape state.
 *   if (stored === undefined || stored === null) { return; }
 *   const state = JSON.parse(stored) as Record<string, unknown>;
 *   state.newField = deriveFrom(state.oldField);
 *   ClientStateSchema.parse(state);
 *   sql`
 *     INSERT OR REPLACE INTO cf_agents_state (id, state)
 *     VALUES (${AGENT_SDK_STATE_ROW_ID}, ${JSON.stringify(state)})
 *   `;
 * }
 * ```
 *
 * A throw from the step (including a `ClientStateSchema` failure) rolls back
 * the transaction and leaves the version unrecorded, so the migration retries
 * on the next cold start rather than committing a row current code cannot read.
 * Steps must never broadcast; migration runs before any connection exists.
 */
export class AgentSdkStateRepository implements Repository {
  readonly name = "agent_sdk_client_state";
  readonly migrations: ReadonlyArray<Migration> = [];
}
