import { describe, expect, it, vi } from "vitest";
import { ClientStateSchema, type ClientState } from "@repo/shared";
import { SessionAgentDO } from "../../src/runtime/session-agent.do";
import { migrateAll } from "../../src/modules/session-agent/repositories/schema-manager.repository";
import { AGENT_SDK_STATE_ROW_ID } from "../../src/modules/session-agent/repositories/agent-sdk-state.repository";
import type { Migration, Repository } from "../../src/modules/session-agent/repositories/repository.types";
import type { Env } from "../../src/shared/types";
import type { FakeAgent } from "./session-agent-do-harness";
import {
  createFakeDurableObjectState,
  createFakeEnv,
  createSqlFn,
  createTestDatabase,
  readAppliedMigrations,
  readClientStateRow,
  readServerStateRow,
  seedAppliedMigrations,
  seedClientStateRow,
  seedClientStateTable,
  seedServerStateRow,
} from "./session-agent-do-harness";

vi.mock("agents", async () => {
  const harness = await import("./session-agent-do-harness");
  return { Agent: harness.FakeAgent, getAgentByName: vi.fn() };
});

/** A client-state row at the current shape, as every live session now is. */
const CURRENT_CLIENT_STATE: ClientState = ClientStateSchema.parse({
  repoFullName: "owner/repo",
  status: "ready",
  sessionSetupRun: null,
  agentSettings: { provider: "claude-code" },
  agentMode: "edit",
  pushedBranch: null,
  pullRequest: null,
  todos: null,
  plan: null,
  pendingUserMessage: null,
  activeTurn: null,
  editorUrl: null,
  providerConnection: null,
  lastError: null,
  baseBranch: null,
  createdAt: "2026-07-01T00:00:00.000Z",
});

/** A server-state row written before newer checkpoint fields existed. */
const HISTORICAL_SERVER_STATE = {
  initialized: true,
  sessionId: "session-1",
  userId: "user-1",
  spriteName: "sprite-1",
  repoCloned: true,
  agentSessionId: null,
  agentProcessId: null,
  activeUserMessageId: null,
  gitConfiguredViaConnector: true,
};

function constructSessionAgent(db: ReturnType<typeof createTestDatabase>, env?: Env) {
  const ctx = createFakeDurableObjectState(db);
  const agent = new SessionAgentDO(ctx, env ?? createFakeEnv());
  return agent as unknown as FakeAgent<Env, ClientState> & { state: ClientState };
}

/**
 * Stand-in for a future surgical client-state migration. Production ships no
 * client-state migration (every session is already at the current shape), so
 * the seam is proven with a fixture instead of a placeholder production entry.
 */
function createFixtureClientStateRepository(steps: ReadonlyArray<Migration>): Repository {
  return { name: "agent_sdk_client_state", migrations: steps };
}

/** Adds a field to the stored row, then validates the whole current shape. */
const backfillStep: Migration = (sql) => {
  const rows = sql<{ state: string | null }>`
    SELECT state FROM cf_agents_state WHERE id = ${AGENT_SDK_STATE_ROW_ID}
  `;
  const stored = rows[0]?.state;
  if (stored === undefined || stored === null) {
    return;
  }
  const state = JSON.parse(stored) as Record<string, unknown>;
  state.baseBranch = "main";
  ClientStateSchema.parse(state);
  sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${AGENT_SDK_STATE_ROW_ID}, ${JSON.stringify(state)})
  `;
};

describe("SessionAgentDO local migrations", () => {
  describe("surgical client-state migration seam", () => {
    it("transforms the SDK row and records the version", () => {
      const db = createTestDatabase();
      seedClientStateRow(db, JSON.stringify(CURRENT_CLIENT_STATE));
      const ctx = createFakeDurableObjectState(db);

      migrateAll(createSqlFn(db), ctx.storage, [
        createFixtureClientStateRepository([backfillStep]),
      ]);

      const migrated = JSON.parse(readClientStateRow(db) as string) as Record<string, unknown>;
      expect(migrated.baseBranch).toBe("main");
      // Fields the step did not touch are untouched.
      expect(migrated.repoFullName).toBe("owner/repo");
      expect(readAppliedMigrations(db, "agent_sdk_client_state")).toEqual([0]);
    });

    it("rolls back atomically and records no version when the result is invalid", () => {
      const db = createTestDatabase();
      const original = JSON.stringify(CURRENT_CLIENT_STATE);
      seedClientStateRow(db, original);
      const ctx = createFakeDurableObjectState(db);
      const invalidStep: Migration = (sql) => {
        const rows = sql<{ state: string }>`
          SELECT state FROM cf_agents_state WHERE id = ${AGENT_SDK_STATE_ROW_ID}
        `;
        const state = JSON.parse(rows[0].state) as Record<string, unknown>;
        state.status = "not-a-status";
        ClientStateSchema.parse(state);
        sql`
          INSERT OR REPLACE INTO cf_agents_state (id, state)
          VALUES (${AGENT_SDK_STATE_ROW_ID}, ${JSON.stringify(state)})
        `;
      };

      expect(() =>
        migrateAll(createSqlFn(db), ctx.storage, [
          createFixtureClientStateRepository([invalidStep]),
        ]),
      ).toThrow();

      // Row is byte-identical and the version was not recorded, so the next
      // cold start retries rather than committing unreadable state.
      expect(readClientStateRow(db)).toBe(original);
      expect(readAppliedMigrations(db, "agent_sdk_client_state")).toEqual([]);
    });

    it("treats an absent SDK row as a no-op whose version is still recorded", () => {
      const db = createTestDatabase();
      // The SDK constructor creates the table before migrations run, so the
      // step sees an existing table with no state row.
      seedClientStateTable(db);
      const ctx = createFakeDurableObjectState(db);

      migrateAll(createSqlFn(db), ctx.storage, [
        createFixtureClientStateRepository([backfillStep]),
      ]);

      expect(readClientStateRow(db)).toBeNull();
      expect(readAppliedMigrations(db, "agent_sdk_client_state")).toEqual([0]);
    });

    it("does not rerun a step whose version is already recorded", () => {
      const db = createTestDatabase();
      const original = JSON.stringify(CURRENT_CLIENT_STATE);
      seedClientStateRow(db, original);
      seedAppliedMigrations(db, "agent_sdk_client_state", [0]);
      const ctx = createFakeDurableObjectState(db);

      migrateAll(createSqlFn(db), ctx.storage, [
        createFixtureClientStateRepository([backfillStep]),
      ]);

      expect(readClientStateRow(db)).toBe(original);
    });

    it("runs only newly appended steps against an established database", () => {
      const db = createTestDatabase();
      seedClientStateRow(db, JSON.stringify(CURRENT_CLIENT_STATE));
      seedAppliedMigrations(db, "agent_sdk_client_state", [0]);
      const ctx = createFakeDurableObjectState(db);
      const appended: Migration = (sql) => {
        sql`
          INSERT OR REPLACE INTO cf_agents_state (id, state)
          VALUES ('fixture_marker', 'appended')
        `;
      };

      migrateAll(createSqlFn(db), ctx.storage, [
        createFixtureClientStateRepository([backfillStep, appended]),
      ]);

      // Version 0 skipped, version 1 applied.
      expect(JSON.parse(readClientStateRow(db) as string).baseBranch).toBeNull();
      expect(readAppliedMigrations(db, "agent_sdk_client_state")).toEqual([0, 1]);
    });
  });

  describe("construction ordering", () => {
    it("ships no client-state migration because live sessions are current", () => {
      const db = createTestDatabase();
      const stored = JSON.stringify(CURRENT_CLIENT_STATE);
      seedClientStateRow(db, stored);

      constructSessionAgent(db);

      // The adapter is registered as the seam for future migrations, but has
      // no steps today, so no row is rewritten and no version is recorded.
      expect(readClientStateRow(db)).toBe(stored);
      expect(readAppliedMigrations(db, "agent_sdk_client_state")).toEqual([]);
    });

    it("completes repository migrations before loading ServerState", () => {
      const db = createTestDatabase();
      seedServerStateRow(db, JSON.stringify(HISTORICAL_SERVER_STATE));

      constructSessionAgent(db);

      // Construction read the historical row successfully, and reading must
      // not rewrite it: old persisted keys stay on disk for rollback safety.
      expect(readServerStateRow(db)).toBe(JSON.stringify(HISTORICAL_SERVER_STATE));
      expect(readAppliedMigrations(db, "server_state")).toEqual([0]);
    });

    it("constructs a fresh session with no seeded rows", () => {
      const db = createTestDatabase();

      constructSessionAgent(db);

      expect(readAppliedMigrations(db, "server_state")).toEqual([0]);
      expect(readServerStateRow(db)).toBeNull();
      expect(readClientStateRow(db)).toBeNull();
    });

    it("neither hydrates nor broadcasts client state during construction", () => {
      const db = createTestDatabase();
      seedClientStateRow(db, JSON.stringify(CURRENT_CLIENT_STATE));

      const agent = constructSessionAgent(db);

      // Migration ran to completion without any service touching client state.
      expect(agent.testStateWriteCount).toBe(0);
      expect(agent.testBroadcasts).toEqual([]);

      // The first read after construction observes the stored row.
      expect(agent.state.repoFullName).toBe("owner/repo");
      expect(agent.testBroadcasts).toEqual([]);
    });
  });
});
