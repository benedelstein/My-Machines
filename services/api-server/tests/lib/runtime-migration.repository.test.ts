import { describe, expect, it } from "vitest";
import { RuntimeMigrationRepository } from
  "../../src/modules/session-agent/repositories/runtime-migration.repository";
import type { RuntimeMigrationError } from
  "../../src/modules/session-agent/types/runtime-migration.types";
import {
  createFakeDurableObjectState,
  createSqlFn,
  createTestDatabase,
} from "./session-agent-do-harness";

function createRepository(): {
  repository: RuntimeMigrationRepository;
  database: ReturnType<typeof createTestDatabase>;
} {
  const database = createTestDatabase();
  const sql = createSqlFn(database);
  const repository = new RuntimeMigrationRepository(sql);
  const storage = createFakeDurableObjectState(database).storage;
  for (const migration of repository.migrations) {
    storage.transactionSync(() => migration(sql));
  }
  return { repository, database };
}

describe("RuntimeMigrationRepository", () => {
  it("persists parsed version attempts and applied revisions", () => {
    const { repository } = createRepository();
    const revision = { kind: "version", version: 2 } as const;

    expect(repository.get("fixture.version", "version")).toEqual({ ok: true, value: null });
    expect(repository.beginAttempt(
      "fixture.version",
      revision,
      "2026-08-01T00:00:00.000Z",
    )).toEqual({ ok: true, value: { attemptCount: 1 } });
    expect(repository.markApplied(
      "fixture.version",
      revision,
      "2026-08-01T00:00:01.000Z",
    )).toEqual({ ok: true, value: undefined });

    const record = repository.get("fixture.version", "version");
    expect(record.ok && record.value).toMatchObject({
      migrationId: "fixture.version",
      appliedRevision: revision,
      attemptedRevision: revision,
      status: "applied",
      attemptCount: 1,
    });
  });

  it("retains an applied revision during a newer attempt and rejects stale completion", () => {
    const { repository } = createRepository();
    const first = { kind: "contract", hash: "a".repeat(64) } as const;
    const second = { kind: "contract", hash: "b".repeat(64) } as const;
    repository.beginAttempt("fixture.contract", first, "2026-08-01T00:00:00.000Z");
    repository.markApplied("fixture.contract", first, "2026-08-01T00:00:01.000Z");
    repository.beginAttempt("fixture.contract", second, "2026-08-01T00:00:02.000Z");

    const running = repository.get("fixture.contract", "contract");
    expect(running.ok && running.value).toMatchObject({
      appliedRevision: first,
      attemptedRevision: second,
      status: "running",
      attemptCount: 2,
    });
    expect(repository.markApplied(
      "fixture.contract",
      first,
      "2026-08-01T00:00:03.000Z",
    )).toMatchObject({ ok: false, error: { code: "MIGRATION_ATTEMPT_CONFLICT" } });
  });

  it("parses every row as untrusted input and detects kind conflicts", () => {
    const { repository, database } = createRepository();
    database.prepare(`
      INSERT INTO session_runtime_migrations (
        migration_id, applied_revision, attempted_revision, status,
        attempt_count, started_at, last_attempt_at, applied_at
      ) VALUES (?, ?, ?, 'applied', 1, ?, ?, ?)
    `).run(
      "fixture.invalid",
      "not-json",
      JSON.stringify({ kind: "contract", hash: "a".repeat(64) }),
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );

    expect(repository.get("fixture.invalid", "contract")).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_RECORD_INVALID" },
    });

    database.prepare(
      "UPDATE session_runtime_migrations SET applied_revision = attempted_revision WHERE migration_id = ?",
    ).run("fixture.invalid");
    expect(repository.get("fixture.invalid", "version")).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_REVISION_KIND_CHANGED" },
    });

    database.prepare(
      "UPDATE session_runtime_migrations SET attempted_revision = ? WHERE migration_id = ?",
    ).run(JSON.stringify({ kind: "version", version: 0 }), "fixture.invalid");
    expect(repository.get("fixture.invalid")).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_RECORD_INVALID" },
    });
  });

  it("bounds persisted failure data and computes capped retry eligibility", () => {
    const { repository } = createRepository();
    const revision = { kind: "version", version: 1 } as const;
    repository.beginAttempt("fixture.failed", revision, "2026-08-01T00:00:00.000Z");
    const error: RuntimeMigrationError = {
      code: "APPLY_FAILED",
      message: "x".repeat(2_000),
      migrationId: "fixture.failed",
    };
    repository.markFailed("fixture.failed", revision, error);

    const recordResult = repository.get("fixture.failed", "version");
    expect(recordResult.ok && recordResult.value?.lastErrorMessage).toHaveLength(512);
    if (!recordResult.ok || !recordResult.value) {
      return;
    }
    expect(repository.getRetryEligibility(
      recordResult.value,
      new Date("2026-08-01T00:00:00.500Z"),
      { baseDelayMs: 1_000, maxDelayMs: 5_000, operatorThreshold: 1 },
    )).toEqual({
      eligible: false,
      retryAt: "2026-08-01T00:00:01.000Z",
      operatorAttentionRequired: true,
    });
  });
});
