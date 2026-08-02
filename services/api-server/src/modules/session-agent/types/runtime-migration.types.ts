import type { Result } from "@repo/shared";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type RuntimeMigrationRevision =
  | { readonly kind: "version"; readonly version: number }
  | { readonly kind: "contract"; readonly hash: string };

export type RuntimeMigrationRevisionKind = RuntimeMigrationRevision["kind"];

export type RuntimeMigrationStatus = "running" | "failed" | "applied";

export interface RuntimeMigrationRecord {
  readonly migrationId: string;
  readonly appliedRevision: RuntimeMigrationRevision | null;
  readonly attemptedRevision: RuntimeMigrationRevision;
  readonly status: RuntimeMigrationStatus;
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly lastAttemptAt: string;
  readonly appliedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface RuntimeMigrationState {
  readonly activeUserMessageId: string | null;
}

export interface RuntimeMigrationContext {
  readonly getServerState: () => RuntimeMigrationState;
  readonly isTeardownStarted: () => boolean;
}

export type RuntimeMigrationErrorCode =
  | "PREPARATION_FAILED"
  | "APPLY_FAILED"
  | "MIGRATION_RECORD_INVALID"
  | "MIGRATION_REPOSITORY_READ_FAILED"
  | "MIGRATION_REPOSITORY_WRITE_FAILED"
  | "MIGRATION_ATTEMPT_CONFLICT"
  | "MIGRATION_REVISION_KIND_CHANGED"
  | "MIGRATION_RETRY_BACKOFF"
  | "MIGRATION_NOT_REGISTERED"
  | "SESSION_TEARDOWN_STARTED";

export interface RuntimeMigrationError {
  readonly code: RuntimeMigrationErrorCode;
  readonly message: string;
  readonly migrationId?: string;
  readonly retryAt?: string;
}

export type RuntimeMigrationCoordinatorOutcome =
  | { readonly outcome: "current" }
  | { readonly outcome: "applied" }
  | { readonly outcome: "deferred_active_turn" };

export type RuntimeMigrationCoordinatorResult = Result<
  RuntimeMigrationCoordinatorOutcome,
  RuntimeMigrationError
>;

export type RuntimeMigrationEntryResult = Result<
  { readonly outcome: "current" } | { readonly outcome: "applied" },
  RuntimeMigrationError
>;

export interface RuntimeMigrationApplyInput<Desired extends JsonValue> {
  readonly context: RuntimeMigrationContext;
  readonly desired: Desired;
  readonly revision: RuntimeMigrationRevision;
  readonly attempt: number;
}

export interface PreparedRuntimeMigration {
  readonly revision: RuntimeMigrationRevision;
  readonly apply: (attempt: number) => Promise<Result<void, RuntimeMigrationError>>;
}

export interface RuntimeMigrationDefinition {
  readonly id: string;
  readonly description: string;
  readonly revisionKind: RuntimeMigrationRevisionKind;
  readonly prepare: (
    context: RuntimeMigrationContext,
  ) => Promise<Result<PreparedRuntimeMigration, RuntimeMigrationError>>;
}

export interface RuntimeMigrationRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly operatorThreshold: number;
}
