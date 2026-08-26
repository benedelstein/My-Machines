import {
  failure,
  success,
  type Logger,
  type Result,
} from "@repo/shared";
import type { RuntimeMigrationRepository } from
  "@/modules/session-agent/repositories/runtime-migration.repository";
import type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";
import type {
  RuntimeMigrationContext,
  RuntimeMigrationCoordinatorResult,
  RuntimeMigrationDefinition,
  RuntimeMigrationEntryResult,
  RuntimeMigrationError,
  RuntimeMigrationRecord,
  RuntimeMigrationRetryPolicy,
  RuntimeMigrationRevision,
} from "@/modules/session-agent/types/runtime-migration.types";
import { assertRuntimeMigrationRegistry } from "./runtime-migration-definition.service";

const DEFAULT_RETRY_POLICY: RuntimeMigrationRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  operatorThreshold: 5,
};

export interface RuntimeMigrationLifecycleEvent {
  readonly event:
    | "prepared"
    | "pending"
    | "current"
    | "running"
    | "applied"
    | "failed"
    | "deferred"
    | "interrupted_retry"
    | "newer_version_skipped";
  readonly migrationId?: string;
  readonly revisionKind?: RuntimeMigrationRevision["kind"];
  readonly revision?: string | number;
  readonly appliedRevision?: string | number;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly operatorAttentionRequired?: boolean;
}

interface RuntimeMigrationCoordinatorDependencies {
  readonly repository: RuntimeMigrationRepository;
  readonly definitions: readonly RuntimeMigrationDefinition[];
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly retryPolicy?: RuntimeMigrationRetryPolicy;
  readonly observe?: (event: RuntimeMigrationLifecycleEvent) => void;
}

type RevisionDisposition =
  | { readonly kind: "apply" }
  | { readonly kind: "current" }
  | { readonly kind: "newer_version"; readonly appliedVersion: number };

interface RetryEligibility {
  readonly status: "running" | "failed";
  readonly nextAttempt: number;
  readonly eligible: boolean;
  readonly retryAt: string | null;
  readonly operatorAttentionRequired: boolean;
}

function compareRevision(
  record: RuntimeMigrationRecord | null,
  desired: RuntimeMigrationRevision,
): Result<RevisionDisposition, RuntimeMigrationError> {
  if (!record?.appliedRevision) {
    return success({ kind: "apply" });
  }

  const applied = record.appliedRevision;
  switch (applied.kind) {
    case "version": {
      if (desired.kind !== "version") {
        return failure({
          code: "MIGRATION_REVISION_KIND_CHANGED",
          message: "A runtime migration changed revision strategy",
          migrationId: record.migrationId,
        });
      }
      if (applied.version > desired.version) {
        return success({ kind: "newer_version", appliedVersion: applied.version });
      }
      return success(
        applied.version < desired.version || record.status !== "applied"
          ? { kind: "apply" }
          : { kind: "current" },
      );
    }
    case "contract": {
      if (desired.kind !== "contract") {
        return failure({
          code: "MIGRATION_REVISION_KIND_CHANGED",
          message: "A runtime migration changed revision strategy",
          migrationId: record.migrationId,
        });
      }
      return success(
        applied.hash !== desired.hash || record.status !== "applied"
          ? { kind: "apply" }
          : { kind: "current" },
      );
    }
  }
}

function getRetryEligibility(
  record: RuntimeMigrationRecord,
  now: Date,
  policy: RuntimeMigrationRetryPolicy,
): RetryEligibility | null {
  switch (record.status) {
    case "applied":
      return null;
    case "running":
    case "failed": {
      const exponent = Math.max(0, record.attemptCount - 1);
      const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
      const lastAttemptMs = Date.parse(record.lastAttemptAt);
      const retryAtMs = lastAttemptMs + delayMs;
      return {
        status: record.status,
        nextAttempt: record.attemptCount + 1,
        eligible: !Number.isFinite(retryAtMs) || now.getTime() >= retryAtMs,
        retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs).toISOString() : null,
        operatorAttentionRequired: record.attemptCount >= policy.operatorThreshold,
      };
    }
  }
}

function revisionValue(revision: RuntimeMigrationRevision): string | number {
  switch (revision.kind) {
    case "version":
      return revision.version;
    case "contract":
      return revision.hash;
  }
}

function safeApplyError(
  migrationId: string,
  error: RuntimeMigrationError,
): RuntimeMigrationError {
  return {
    code: error.code,
    message: "Runtime migration apply or verification failed",
    migrationId,
  };
}

export class RuntimeMigrationCoordinator {
  private readonly repository: RuntimeMigrationRepository;
  private readonly definitions: readonly RuntimeMigrationDefinition[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly retryPolicy: RuntimeMigrationRetryPolicy;
  private readonly observe: (event: RuntimeMigrationLifecycleEvent) => void;

  constructor(dependencies: RuntimeMigrationCoordinatorDependencies) {
    assertRuntimeMigrationRegistry(dependencies.definitions);
    this.repository = dependencies.repository;
    this.definitions = dependencies.definitions;
    this.logger = dependencies.logger;
    this.now = dependencies.now ?? (() => new Date());
    this.retryPolicy = dependencies.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.observe = dependencies.observe ?? (() => {});
  }

  /** Ensures the complete static registry while the caller owns the runtime boundary. */
  async ensureMigrations(
    context: RuntimeMigrationContext,
    _lease: RuntimeBoundaryLease,
  ): Promise<RuntimeMigrationCoordinatorResult> {
    return this.ensureDefinitions(this.definitions, context);
  }

  /** Ensures the registry prefix while the caller's lease proves mutex ownership. */
  async ensureMigration(
    migrationId: string,
    context: RuntimeMigrationContext,
    _lease: RuntimeBoundaryLease,
  ): Promise<RuntimeMigrationCoordinatorResult> {
    const targetIndex = this.definitions.findIndex((definition) => definition.id === migrationId);
    if (targetIndex < 0) {
      return failure({
        code: "MIGRATION_NOT_REGISTERED",
        message: "The requested runtime migration is not registered",
        migrationId,
      });
    }
    return this.ensureDefinitions(this.definitions.slice(0, targetIndex + 1), context);
  }

  private async ensureDefinitions(
    definitions: readonly RuntimeMigrationDefinition[],
    context: RuntimeMigrationContext,
  ): Promise<RuntimeMigrationCoordinatorResult> {
    if (context.isTeardownStarted()) {
      return failure({
        code: "SESSION_TEARDOWN_STARTED",
        message: "Runtime migration work cannot begin during session teardown",
      });
    }
    if (context.getServerState().activeUserMessageId !== null) {
      this.logger.debug("Runtime migrations deferred for active turn", {
        fields: { event: "deferred" },
      });
      this.observe({ event: "deferred" });
      return success({ outcome: "deferred_active_turn" });
    }

    let appliedAny = false;
    for (const definition of definitions) {
      const result = await this.ensureDefinition(definition, context);
      if (!result.ok) {
        return result;
      }
      if (result.value.outcome === "applied") {
        appliedAny = true;
      }
    }
    return success({ outcome: appliedAny ? "applied" : "current" });
  }

  private async ensureDefinition(
    definition: RuntimeMigrationDefinition,
    context: RuntimeMigrationContext,
  ): Promise<RuntimeMigrationEntryResult> {
    let preparedResult: Awaited<ReturnType<RuntimeMigrationDefinition["prepare"]>>;
    try {
      preparedResult = await definition.prepare(context);
    } catch {
      preparedResult = failure({
        code: "PREPARATION_FAILED",
        message: "Runtime migration desired state could not be prepared",
        migrationId: definition.id,
      });
    }
    if (!preparedResult.ok) {
      this.logFailure(definition.id, preparedResult.error);
      return preparedResult;
    }

    const prepared = preparedResult.value;
    this.logEvent({
      event: "prepared",
      migrationId: definition.id,
      revisionKind: prepared.revision.kind,
      revision: revisionValue(prepared.revision),
    });

    const recordResult = this.repository.get(definition.id, definition.revisionKind);
    if (!recordResult.ok) {
      this.logFailure(definition.id, recordResult.error);
      return recordResult;
    }
    const record = recordResult.value;
    const comparison = compareRevision(record, prepared.revision);
    if (!comparison.ok) {
      this.logFailure(definition.id, comparison.error);
      return comparison;
    }
    if (comparison.value.kind !== "apply") {
      this.logEvent({
        event: comparison.value.kind === "newer_version"
          ? "newer_version_skipped"
          : "current",
        migrationId: definition.id,
        revisionKind: prepared.revision.kind,
        revision: revisionValue(prepared.revision),
        ...(comparison.value.kind === "newer_version"
          ? { appliedRevision: comparison.value.appliedVersion }
          : {}),
      });
      return success({ outcome: "current" });
    }

    this.logEvent({
      event: "pending",
      migrationId: definition.id,
      revisionKind: prepared.revision.kind,
      revision: revisionValue(prepared.revision),
    });
    const retry = record
      ? getRetryEligibility(record, this.now(), this.retryPolicy)
      : null;
    if (retry) {
      if (!retry.eligible) {
        const error: RuntimeMigrationError = {
          code: "MIGRATION_RETRY_BACKOFF",
          message: "Runtime migration retry is waiting for bounded backoff",
          migrationId: definition.id,
          ...(retry.retryAt ? { retryAt: retry.retryAt } : {}),
        };
        this.logFailure(definition.id, error, retry.operatorAttentionRequired);
        return failure(error);
      }
      if (retry.status === "running") {
        this.logEvent({
          event: "interrupted_retry",
          migrationId: definition.id,
          revisionKind: prepared.revision.kind,
          revision: revisionValue(prepared.revision),
          attempt: retry.nextAttempt,
          operatorAttentionRequired: retry.operatorAttentionRequired,
        });
      }
    }

    const startedAt = this.now();
    const attemptResult = this.repository.beginAttempt(
      definition.id,
      prepared.revision,
      startedAt.toISOString(),
    );
    if (!attemptResult.ok) {
      this.logFailure(definition.id, attemptResult.error);
      return attemptResult;
    }
    const attempt = attemptResult.value.attemptCount;
    this.logEvent({
      event: "running",
      migrationId: definition.id,
      revisionKind: prepared.revision.kind,
      revision: revisionValue(prepared.revision),
      attempt,
    });

    let applyResult: Awaited<ReturnType<typeof prepared.apply>>;
    try {
      applyResult = await prepared.apply(attempt);
    } catch {
      applyResult = failure({
        code: "APPLY_FAILED",
        message: "Runtime migration apply or verification failed",
        migrationId: definition.id,
      });
    }
    if (!applyResult.ok) {
      const safeError = safeApplyError(definition.id, applyResult.error);
      const failedRecord = this.repository.markFailed(
        definition.id,
        prepared.revision,
        safeError,
      );
      if (!failedRecord.ok) {
        this.logFailure(definition.id, failedRecord.error);
        return failedRecord;
      }
      this.logFailure(definition.id, safeError, attempt >= this.retryPolicy.operatorThreshold);
      return failure(safeError);
    }

    const appliedAt = this.now();
    const appliedResult = this.repository.markApplied(
      definition.id,
      prepared.revision,
      appliedAt.toISOString(),
    );
    if (!appliedResult.ok) {
      this.logFailure(definition.id, appliedResult.error);
      return appliedResult;
    }
    this.logEvent({
      event: "applied",
      migrationId: definition.id,
      revisionKind: prepared.revision.kind,
      revision: revisionValue(prepared.revision),
      attempt,
      durationMs: Math.max(0, appliedAt.getTime() - startedAt.getTime()),
    });
    return success({ outcome: "applied" });
  }

  private logFailure(
    migrationId: string,
    error: RuntimeMigrationError,
    operatorAttentionRequired = false,
  ): void {
    this.logEvent({
      event: "failed",
      migrationId,
      errorCode: error.code,
      operatorAttentionRequired,
    });
  }

  private logEvent(event: RuntimeMigrationLifecycleEvent): void {
    const fields = {
      event: event.event,
      migrationId: event.migrationId ?? null,
      revisionKind: event.revisionKind ?? null,
      revision: event.revision ?? null,
      appliedRevision: event.appliedRevision ?? null,
      attempt: event.attempt ?? null,
      durationMs: event.durationMs ?? null,
      errorCode: event.errorCode ?? null,
      operatorAttentionRequired: event.operatorAttentionRequired ?? false,
    };
    if (event.event === "failed" || event.event === "newer_version_skipped") {
      this.logger.warn("Runtime migration lifecycle event", { fields });
    } else {
      this.logger.info("Runtime migration lifecycle event", { fields });
    }
    this.observe(event);
  }
}
