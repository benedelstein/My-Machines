import { DatabaseSync } from "node:sqlite";
import type { Env } from "../../src/shared/types";

/**
 * Historical Durable Object fixture harness.
 *
 * Backs a fake `DurableObjectState` and a behavioral fake of the Agents SDK
 * `Agent` base class with a real in-memory SQLite database so tests can:
 * - seed raw SQLite/JSON rows and `schema_migrations` versions before
 *   construction (historical states);
 * - construct the real `SessionAgentDO` against that database;
 * - inspect rows and broadcast activity before/without normal application
 *   access.
 *
 * The fake reproduces the SDK storage contract (constructor-created
 * `cf_agents_state` table, lazy `state` hydration from `cf_state_row_id`,
 * broadcasting `_setStateInternal`). The real SDK is pinned to this contract
 * by `agents-sdk-state-contract.test.ts`.
 */

export const AGENT_SDK_STATE_ROW_ID = "cf_state_row_id";

/** Sentinel matching the SDK's unhydrated-state marker. */
const UNHYDRATED = Symbol("unhydrated-state");

type SqlValue = string | number | boolean | null;

function bindValue(value: SqlValue): string | number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

export function createFakeDurableObjectState(db: DatabaseSync): DurableObjectState {
  const storage = {
    sql: {
      exec(query: string, ...values: SqlValue[]): Iterable<Record<string, unknown>> {
        return db.prepare(query).all(...values.map(bindValue)) as Record<string, unknown>[];
      },
    },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

/**
 * Behavioral fake of the Agents SDK `Agent` base class covering the surface
 * `SessionAgentDO` construction and state hydration exercise.
 */
export class FakeAgent<TEnv = unknown, TState = unknown> {
  ctx: DurableObjectState;
  env: TEnv;
  initialState: TState | typeof UNHYDRATED = UNHYDRATED;
  private hydratedState: TState | typeof UNHYDRATED = UNHYDRATED;

  /** Raw `broadcast()` payloads observed since construction. */
  readonly testBroadcasts: string[] = [];
  /** Number of `_setStateInternal` calls (the SDK broadcasts on each). */
  testStateWriteCount = 0;
  /** Messages sent directly to a connection by the Durable Object. */
  readonly testSentMessages: unknown[] = [];

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;
  }

  sql<T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
      "",
    );
    const storageSql = (this.ctx.storage as unknown as {
      sql: { exec(query: string, ...values: SqlValue[]): Iterable<T> };
    }).sql;
    return [...storageSql.exec(query, ...values)];
  }

  get state(): TState {
    if (this.hydratedState !== UNHYDRATED) {
      return this.hydratedState;
    }
    const rows = this.sql<{ state: string }>`
      SELECT state FROM cf_agents_state WHERE id = ${AGENT_SDK_STATE_ROW_ID}
    `;
    if (rows.length > 0) {
      this.hydratedState = JSON.parse(rows[0].state) as TState;
      return this.hydratedState;
    }
    if (this.initialState === UNHYDRATED) {
      throw new Error("FakeAgent has no stored state and no initialState");
    }
    this._setStateInternal(this.initialState, "server");
    return this.initialState;
  }

  setState(state: TState): void {
    this._setStateInternal(state, "server");
  }

  _setStateInternal(state: TState, _source: unknown): void {
    this.hydratedState = state;
    this.testStateWriteCount += 1;
    this.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${AGENT_SDK_STATE_ROW_ID}, ${JSON.stringify(state)})
    `;
  }

  broadcast(message: string, _without?: string[]): void {
    this.testBroadcasts.push(message);
  }

  sendMessage(message: unknown, _connection: unknown): void {
    this.testSentMessages.push(message);
  }

  getConnections(): Iterable<never> {
    return [];
  }

  async keepAliveWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  get name(): string {
    return "fake-agent";
  }
}

/**
 * Tagged-template SQL function over the test database, matching the SDK's
 * `sql` surface. Lets tests drive `migrateAll` directly with fixture
 * repositories, without constructing a Durable Object.
 */
export function createSqlFn(db: DatabaseSync) {
  return (<T = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] => {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
      "",
    );
    return db.prepare(query).all(...values.map(bindValue)) as T[];
  });
}

export function createFakeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    LOG_LEVEL: "error",
    DB: {},
    SPRITES_API_KEY: "test-sprites-key",
    SPRITES_API_URL: "https://sprites.example.test",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: btoa("private-key"),
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "my-machines",
    TOKEN_ENCRYPTION_KEY: "token-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    WEB_ORIGIN: "https://example.test",
    ...overrides,
  } as unknown as Env;
}

// --- Raw-row fixture helpers (usable before construction) -------------------

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    repo TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, version)
  )
`;

/** Record already-applied migration versions for a repository. */
export function seedAppliedMigrations(db: DatabaseSync, repo: string, versions: number[]): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  for (const version of versions) {
    db.prepare("INSERT INTO schema_migrations (repo, version) VALUES (?, ?)").run(repo, version);
  }
}

export function readAppliedMigrations(db: DatabaseSync, repo: string): number[] {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  return db
    .prepare("SELECT version FROM schema_migrations WHERE repo = ? ORDER BY version")
    .all(repo)
    .map((row) => Number((row as { version: number }).version));
}

/** Seed a raw historical ServerState JSON row (creates the table if needed). */
export function seedServerStateRow(db: DatabaseSync, stateJson: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS server_state (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL DEFAULT '{}')");
  db.prepare("INSERT OR REPLACE INTO server_state (id, state) VALUES ('state', ?)").run(stateJson);
}

export function readServerStateRow(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT state FROM server_state WHERE id = 'state'").get() as
    | { state: string }
    | undefined;
  return row?.state ?? null;
}

/**
 * Create the SDK client-state table with no rows. Mirrors what the real SDK
 * constructor guarantees before `migrateAll` runs, so a migration may assume
 * the table exists even when the state row does not.
 */
export function seedClientStateTable(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY NOT NULL, state TEXT)");
}

/** Seed a raw historical Agents SDK client-state row (creates the table if needed). */
export function seedClientStateRow(db: DatabaseSync, stateJson: string): void {
  seedClientStateTable(db);
  db.prepare("INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)").run(
    AGENT_SDK_STATE_ROW_ID,
    stateJson,
  );
}

export function readClientStateRow(db: DatabaseSync): string | null {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'")
    .all();
  if (tables.length === 0) {
    return null;
  }
  const row = db.prepare("SELECT state FROM cf_agents_state WHERE id = ?").get(AGENT_SDK_STATE_ROW_ID) as
    | { state: string }
    | undefined;
  return row?.state ?? null;
}

export function createTestDatabase(): DatabaseSync {
  return new DatabaseSync(":memory:");
}
