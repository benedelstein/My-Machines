import type { Result } from "@repo/shared";
import type { RuntimeMigrationDependencies } from "./runtime-migration-dependencies.types";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type RuntimeMigrationRevision =
  | { readonly kind: "version"; readonly version: number }
  | {
    readonly kind: "contract";
    /** The semantic hash of the desired state. */
    readonly hash: string;
  };

export type RuntimeMigrationRevisionKind = RuntimeMigrationRevision["kind"];

export type RuntimeMigrationStatus = "running" | "failed" | "applied";

/** DB record for a runtime migration. */
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

export type { RuntimeMigrationDependencies } from "./runtime-migration-dependencies.types";

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

export interface RuntimeMigrationApplyInput<Context, Desired extends JsonValue> {
  /** The definition's own context, produced by its `buildContext`. */
  readonly context: Context;
  readonly desired: Desired;
  readonly revision: RuntimeMigrationRevision;
  readonly attempt: number;
}

export interface PreparedRuntimeMigration {
  readonly revision: RuntimeMigrationRevision;
  readonly apply: (attempt: number) => Promise<Result<void, RuntimeMigrationError>>;
}

export interface RuntimeMigrationDefinition<Id extends string = string> {
  readonly id: Id;
  readonly description: string;
  readonly revisionKind: RuntimeMigrationRevisionKind;
  /**
   * Builds this migration's own context from these dependencies, then its
   * desired revision. The context type stays inside the definition, so the
   * coordinator never needs to know what any individual adopter depends on.
   */
  readonly prepare: (
    dependencies: RuntimeMigrationDependencies,
  ) => Promise<Result<PreparedRuntimeMigration, RuntimeMigrationError>>;
}

export interface RuntimeMigrationRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly operatorThreshold: number;
}
