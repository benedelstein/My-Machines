import { z } from "zod";
import { failure, success, type Result } from "@repo/shared";
import type { Migration, Repository, SqlFn } from "./repository.types";
import type {
  RuntimeMigrationError,
  RuntimeMigrationRecord,
  RuntimeMigrationRetryEligibility,
  RuntimeMigrationRetryPolicy,
  RuntimeMigrationRevision,
  RuntimeMigrationRevisionKind,
} from "@/modules/session-agent/types/runtime-migration.types";
import {
  isSha256Digest,
  serializeRuntimeMigrationRevision,
} from "@/modules/session-agent/utils/runtime-migration-contract.utils";

const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const TimestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));

const RuntimeMigrationRevisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("version"),
    version: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    kind: z.literal("contract"),
    hash: z.string().refine(isSha256Digest),
  }).strict(),
]);

const RuntimeMigrationRowSchema = z.object({
  migration_id: z.string().min(1),
  applied_revision: z.string().nullable(),
  attempted_revision: z.string(),
  status: z.enum(["running", "failed", "applied"]),
  attempt_count: z.number().int().positive(),
  started_at: TimestampSchema.nullable(),
  last_attempt_at: TimestampSchema,
  applied_at: TimestampSchema.nullable(),
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
});

type RuntimeMigrationRow = z.infer<typeof RuntimeMigrationRowSchema>;
type RepositoryResult<Value> = Result<Value, RuntimeMigrationError>;

function repositoryError(
  code: "MIGRATION_REPOSITORY_READ_FAILED" | "MIGRATION_REPOSITORY_WRITE_FAILED",
  migrationId?: string,
): RuntimeMigrationError {
  return {
    code,
    message: code === "MIGRATION_REPOSITORY_READ_FAILED"
      ? "Runtime migration records could not be read"
      : "Runtime migration records could not be written",
    migrationId,
  };
}

function invalidRecord(migrationId?: string): RuntimeMigrationError {
  return {
    code: "MIGRATION_RECORD_INVALID",
    message: "A runtime migration record is invalid",
    migrationId,
  };
}

function parseRevision(raw: string | null): RuntimeMigrationRevision | null {
  if (raw === null) {
    return null;
  }
  return RuntimeMigrationRevisionSchema.parse(JSON.parse(raw) as unknown);
}

function parseRecord(
  raw: unknown,
  expectedKind?: RuntimeMigrationRevisionKind,
): RepositoryResult<RuntimeMigrationRecord> {
  const parsedRow = RuntimeMigrationRowSchema.safeParse(raw);
  if (!parsedRow.success) {
    return failure(invalidRecord());
  }

  try {
    const row = parsedRow.data;
    const appliedRevision = parseRevision(row.applied_revision);
    const attemptedRevision = parseRevision(row.attempted_revision);
    if (!attemptedRevision) {
      return failure(invalidRecord(row.migration_id));
    }
    if (appliedRevision && appliedRevision.kind !== attemptedRevision.kind) {
      return failure(invalidRecord(row.migration_id));
    }
    if (
      row.status === "applied"
      && (
        !appliedRevision
        || !row.applied_at
        || serializeRuntimeMigrationRevision(appliedRevision)
          !== serializeRuntimeMigrationRevision(attemptedRevision)
      )
    ) {
      return failure(invalidRecord(row.migration_id));
    }
    if (expectedKind && attemptedRevision.kind !== expectedKind) {
      return failure({
        code: "MIGRATION_REVISION_KIND_CHANGED",
        message: "A runtime migration changed revision strategy",
        migrationId: row.migration_id,
      });
    }
    return success({
      migrationId: row.migration_id,
      appliedRevision,
      attemptedRevision,
      status: row.status,
      attemptCount: row.attempt_count,
      startedAt: row.started_at,
      lastAttemptAt: row.last_attempt_at,
      appliedAt: row.applied_at,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
    });
  } catch {
    return failure(invalidRecord(parsedRow.data.migration_id));
  }
}

function bounded(value: string, maximumLength: number): string {
  return value.slice(0, maximumLength);
}

export class RuntimeMigrationRepository implements Repository {
  readonly name = "session_runtime_migrations";
  readonly migrations: ReadonlyArray<Migration> = [
    (sql) => {
      sql`
        CREATE TABLE IF NOT EXISTS session_runtime_migrations (
          migration_id TEXT PRIMARY KEY NOT NULL,
          applied_revision TEXT,
          attempted_revision TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'applied')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          last_attempt_at TEXT NOT NULL,
          applied_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT
        )
      `;
    },
  ];

  constructor(private readonly sql: SqlFn) {}

  get(
    migrationId: string,
    expectedKind?: RuntimeMigrationRevisionKind,
  ): RepositoryResult<RuntimeMigrationRecord | null> {
    try {
      const rows = this.sql<RuntimeMigrationRow>`
        SELECT migration_id, applied_revision, attempted_revision, status,
          attempt_count, started_at, last_attempt_at, applied_at,
          last_error_code, last_error_message
        FROM session_runtime_migrations
        WHERE migration_id = ${migrationId}
      `;
      if (!rows[0]) {
        return success(null);
      }
      return parseRecord(rows[0], expectedKind);
    } catch {
      return failure(repositoryError("MIGRATION_REPOSITORY_READ_FAILED", migrationId));
    }
  }

  list(): RepositoryResult<RuntimeMigrationRecord[]> {
    try {
      const rows = this.sql<RuntimeMigrationRow>`
        SELECT migration_id, applied_revision, attempted_revision, status,
          attempt_count, started_at, last_attempt_at, applied_at,
          last_error_code, last_error_message
        FROM session_runtime_migrations
        ORDER BY migration_id
      `;
      const records: RuntimeMigrationRecord[] = [];
      for (const row of rows) {
        const parsed = parseRecord(row);
        if (!parsed.ok) {
          return parsed;
        }
        records.push(parsed.value);
      }
      return success(records);
    } catch {
      return failure(repositoryError("MIGRATION_REPOSITORY_READ_FAILED"));
    }
  }

  beginAttempt(
    migrationId: string,
    revision: RuntimeMigrationRevision,
    attemptedAt: string,
  ): RepositoryResult<{ readonly attemptCount: number }> {
    const serializedRevision = serializeRuntimeMigrationRevision(revision);
    try {
      const rows = this.sql<{ attempt_count: number }>`
        INSERT INTO session_runtime_migrations (
          migration_id, applied_revision, attempted_revision, status,
          attempt_count, started_at, last_attempt_at, applied_at,
          last_error_code, last_error_message
        ) VALUES (
          ${migrationId}, NULL, ${serializedRevision}, 'running',
          1, ${attemptedAt}, ${attemptedAt}, NULL, NULL, NULL
        )
        ON CONFLICT(migration_id) DO UPDATE SET
          attempted_revision = excluded.attempted_revision,
          status = 'running',
          attempt_count = session_runtime_migrations.attempt_count + 1,
          started_at = COALESCE(session_runtime_migrations.started_at, excluded.started_at),
          last_attempt_at = excluded.last_attempt_at,
          last_error_code = NULL,
          last_error_message = NULL
        RETURNING attempt_count
      `;
      const attemptCount = rows[0]?.attempt_count;
      return typeof attemptCount === "number"
        ? success({ attemptCount })
        : failure(repositoryError("MIGRATION_REPOSITORY_WRITE_FAILED", migrationId));
    } catch {
      return failure(repositoryError("MIGRATION_REPOSITORY_WRITE_FAILED", migrationId));
    }
  }

  markApplied(
    migrationId: string,
    revision: RuntimeMigrationRevision,
    appliedAt: string,
  ): RepositoryResult<void> {
    const serializedRevision = serializeRuntimeMigrationRevision(revision);
    try {
      const rows = this.sql<{ migration_id: string }>`
        UPDATE session_runtime_migrations
        SET applied_revision = ${serializedRevision}, status = 'applied',
          applied_at = ${appliedAt}, last_error_code = NULL, last_error_message = NULL
        WHERE migration_id = ${migrationId}
          AND attempted_revision = ${serializedRevision}
          AND status = 'running'
        RETURNING migration_id
      `;
      return rows[0]
        ? success(undefined)
        : failure({
            code: "MIGRATION_ATTEMPT_CONFLICT",
            message: "A newer runtime migration attempt replaced this attempt",
            migrationId,
          });
    } catch {
      return failure(repositoryError("MIGRATION_REPOSITORY_WRITE_FAILED", migrationId));
    }
  }

  markFailed(
    migrationId: string,
    revision: RuntimeMigrationRevision,
    error: RuntimeMigrationError,
  ): RepositoryResult<void> {
    const serializedRevision = serializeRuntimeMigrationRevision(revision);
    const errorCode = bounded(error.code, MAX_ERROR_CODE_LENGTH);
    const errorMessage = bounded(error.message, MAX_ERROR_MESSAGE_LENGTH);
    try {
      const rows = this.sql<{ migration_id: string }>`
        UPDATE session_runtime_migrations
        SET status = 'failed', last_error_code = ${errorCode},
          last_error_message = ${errorMessage}
        WHERE migration_id = ${migrationId}
          AND attempted_revision = ${serializedRevision}
          AND status = 'running'
        RETURNING migration_id
      `;
      return rows[0]
        ? success(undefined)
        : failure({
            code: "MIGRATION_ATTEMPT_CONFLICT",
            message: "A newer runtime migration attempt replaced this attempt",
            migrationId,
          });
    } catch {
      return failure(repositoryError("MIGRATION_REPOSITORY_WRITE_FAILED", migrationId));
    }
  }

  getRetryEligibility(
    record: RuntimeMigrationRecord,
    now: Date,
    policy: RuntimeMigrationRetryPolicy,
  ): RuntimeMigrationRetryEligibility {
    const exponent = Math.max(0, record.attemptCount - 1);
    const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
    const lastAttemptMs = Date.parse(record.lastAttemptAt);
    const retryAtMs = lastAttemptMs + delayMs;
    return {
      eligible: !Number.isFinite(retryAtMs) || now.getTime() >= retryAtMs,
      retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs).toISOString() : null,
      operatorAttentionRequired: record.attemptCount >= policy.operatorThreshold,
    };
  }
}
