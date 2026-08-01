import {
  failure,
  success,
  type Logger,
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

export interface RuntimeMigrationObservation {
  readonly outcome:
    | "prepared"
    | "pending"
    | "current"
    | "running"
    | "applied"
    | "failed"
    | "deferred"
    | "stale_retried";
  readonly migrationId?: string;
  readonly revisionKind?: RuntimeMigrationRevision["kind"];
  readonly revision?: string | number;
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
  readonly observe?: (observation: RuntimeMigrationObservation) => void;
}

function needsApply(
  record: RuntimeMigrationRecord | null,
  desired: RuntimeMigrationRevision,
): boolean {
  if (!record?.appliedRevision) {
    return true;
  }

  const applied = record.appliedRevision;
  if (applied.kind !== desired.kind) {
    return true;
  }
  switch (desired.kind) {
    case "version": {
      if (applied.kind !== "version") {
        return true;
      }
      if (applied.version > desired.version) {
        return false;
      }
      return applied.version < desired.version || record.status !== "applied";
    }
    case "contract": {
      if (applied.kind !== "contract") {
        return true;
      }
      return applied.hash !== desired.hash || record.status !== "applied";
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
  private readonly observe: (observation: RuntimeMigrationObservation) => void;

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

  /** Ensures the registry prefix through `migrationId` without reacquiring the boundary. */
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

  /** Returns failed/running records for operator diagnostics without exposing contracts. */
  listDiagnostics(): ReturnType<RuntimeMigrationRepository["list"]> {
    const records = this.repository.list();
    if (!records.ok) {
      return records;
    }
    return success(records.value.filter((record) => record.status !== "applied"));
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
        fields: { outcome: "deferred" },
      });
      this.observe({ outcome: "deferred" });
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
    this.logObservation({
      outcome: "prepared",
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
    if (!needsApply(record, prepared.revision)) {
      this.logObservation({
        outcome: "current",
        migrationId: definition.id,
        revisionKind: prepared.revision.kind,
        revision: revisionValue(prepared.revision),
      });
      return success({ outcome: "current" });
    }

    this.logObservation({
      outcome: "pending",
      migrationId: definition.id,
      revisionKind: prepared.revision.kind,
      revision: revisionValue(prepared.revision),
    });
    if (record && (record.status === "running" || record.status === "failed")) {
      const retry = this.repository.getRetryEligibility(record, this.now(), this.retryPolicy);
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
      if (record.status === "running") {
        this.logObservation({
          outcome: "stale_retried",
          migrationId: definition.id,
          revisionKind: prepared.revision.kind,
          revision: revisionValue(prepared.revision),
          attempt: record.attemptCount + 1,
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
    this.logObservation({
      outcome: "running",
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
    this.logObservation({
      outcome: "applied",
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
    this.logObservation({
      outcome: "failed",
      migrationId,
      errorCode: error.code,
      operatorAttentionRequired,
    });
  }

  private logObservation(observation: RuntimeMigrationObservation): void {
    const fields = {
      outcome: observation.outcome,
      migrationId: observation.migrationId ?? null,
      revisionKind: observation.revisionKind ?? null,
      revision: observation.revision ?? null,
      attempt: observation.attempt ?? null,
      durationMs: observation.durationMs ?? null,
      errorCode: observation.errorCode ?? null,
      operatorAttentionRequired: observation.operatorAttentionRequired ?? false,
    };
    if (observation.outcome === "failed") {
      this.logger.warn("Runtime migration lifecycle event", { fields });
    } else {
      this.logger.info("Runtime migration lifecycle event", { fields });
    }
    this.observe(observation);
  }
}
