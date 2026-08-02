import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_SDK_STATE_ROW_ID,
  AGENT_SDK_STATE_TABLE,
} from "../../src/modules/session-agent/repositories/agent-sdk-state.repository";

/**
 * Integration contract test for the pinned Agents SDK storage behavior that the
 * migration-only client-state adapter and the test harness fake depend on:
 *
 * - the constructor (via `super()`) creates the `cf_agents_state` table before
 *   subclass constructor bodies run;
 * - client state is stored as one JSON row keyed by `cf_state_row_id`;
 * - state hydration is lazy, so a row migrated after `super()` but before the
 *   first `this.state` access is what the application observes.
 *
 * If a pinned-version bump breaks any assertion here, the adapter in
 * `agent-sdk-state.repository.ts` and the harness fake must be re-verified.
 */

// The real SDK, not the global test mock. The SDK's cloudflare:* imports
// resolve through the vitest aliases in vitest.config.ts.
vi.unmock("agents");

const EXPECTED_AGENTS_VERSION = "0.10.1";

interface FakeSqlCursor {
  [Symbol.iterator](): Iterator<Record<string, unknown>>;
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown> | undefined;
}

interface FakeStorage {
  sql: { exec(query: string, ...values: unknown[]): FakeSqlCursor };
  transactionSync<T>(callback: () => T): T;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

function createFakeCtx(db: DatabaseSync): { storage: FakeStorage } {
  const kv = new Map<string, unknown>();
  return {
    getWebSockets: () => [],
    waitUntil: () => undefined,
    storage: {
      sql: {
        exec(query: string, ...values: unknown[]): FakeSqlCursor {
          const rows = db
            .prepare(query)
            .all(...(values as (string | number | null)[])) as Record<string, unknown>[];
          return {
            [Symbol.iterator]: () => rows[Symbol.iterator](),
            toArray: () => rows,
            one: () => rows[0],
          };
        },
      },
      transactionSync<T>(callback: () => T): T {
        return callback();
      },
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
    },
  };
}

async function createAgentClass() {
  const { Agent } = await import("agents");
  class ContractTestAgent extends Agent<Record<string, never>, { value: number }> {
    initialState = { value: 1 };
  }
  return ContractTestAgent;
}

describe("Agents SDK client-state storage contract", () => {
  it("pins the verified SDK version", () => {
    const require = createRequire(import.meta.url);
    // "agents" does not export package.json; resolve the entry and walk up.
    const entryPath = require.resolve("agents");
    const packageRoot = entryPath.slice(0, entryPath.lastIndexOf("/dist/"));
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(packageJson.version).toBe(EXPECTED_AGENTS_VERSION);
  });

  it("creates the cf_agents_state table during construction", async () => {
    const ContractTestAgent = await createAgentClass();
    const db = new DatabaseSync(":memory:");

    new ContractTestAgent(createFakeCtx(db) as never, {});

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(AGENT_SDK_STATE_TABLE);
    expect(tables).toHaveLength(1);
  });

  it("hydrates state lazily from the cf_state_row_id row", async () => {
    const ContractTestAgent = await createAgentClass();
    const db = new DatabaseSync(":memory:");
    const agent = new ContractTestAgent(createFakeCtx(db) as never, {});

    // Simulate a row migrated after construction but before first access.
    db.prepare("INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)").run(
      AGENT_SDK_STATE_ROW_ID,
      JSON.stringify({ value: 42 }),
    );

    expect(agent.state).toEqual({ value: 42 });
  });

  it("initializes and persists initialState at cf_state_row_id when no row exists", async () => {
    const ContractTestAgent = await createAgentClass();
    const db = new DatabaseSync(":memory:");
    const agent = new ContractTestAgent(createFakeCtx(db) as never, {});

    expect(agent.state).toEqual({ value: 1 });

    const row = db
      .prepare("SELECT state FROM cf_agents_state WHERE id = ?")
      .get(AGENT_SDK_STATE_ROW_ID) as { state: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse((row as { state: string }).state)).toEqual({ value: 1 });
  });
});
