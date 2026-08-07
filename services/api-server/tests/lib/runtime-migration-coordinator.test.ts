import { describe, expect, it, vi } from "vitest";
import {
  failure,
  success,
  type Logger,
} from "@repo/shared";
import { RuntimeMigrationRepository } from
  "../../src/modules/session-agent/repositories/runtime-migration.repository";
import {
  RuntimeMigrationCoordinator,
  type RuntimeMigrationLifecycleEvent,
} from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-coordinator.service";
import {
  defineContractRuntimeMigration,
  defineVersionedRuntimeMigration,
} from "../../src/modules/session-agent/services/runtime-migration/runtime-migration-definition.service";
import type { RuntimeBoundaryLease } from
  "../../src/modules/session-agent/types/runtime-boundary.types";
import type { RuntimeMigrationDefinition } from
  "../../src/modules/session-agent/types/runtime-migration.types";
import { fingerprintHighEntropySecret } from
  "../../src/modules/session-agent/utils/runtime-migration-contract.utils";
import {
  createFakeDurableObjectState,
  createSqlFn,
  createTestDatabase,
} from "./session-agent-do-harness";
import { createMigrationHost } from "./runtime-migration-test-support";

const lease = {} as RuntimeBoundaryLease;

function createLogger(): Logger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const logger: Logger & { calls: unknown[][] } = {
    calls,
    log: vi.fn((...args: unknown[]) => calls.push(args)),
    debug: vi.fn((...args: unknown[]) => calls.push(args)),
    info: vi.fn((...args: unknown[]) => calls.push(args)),
    warn: vi.fn((...args: unknown[]) => calls.push(args)),
    error: vi.fn((...args: unknown[]) => calls.push(args)),
    scope: vi.fn(() => logger),
  };
  return logger;
}

function createFixture(
  definitions: readonly RuntimeMigrationDefinition[],
  options: {
    now?: () => Date;
    retryDelayMs?: number;
    observe?: (event: RuntimeMigrationLifecycleEvent) => void;
  } = {},
): {
  coordinator: RuntimeMigrationCoordinator;
  repository: RuntimeMigrationRepository;
  logger: ReturnType<typeof createLogger>;
} {
  const database = createTestDatabase();
  const sql = createSqlFn(database);
  const repository = new RuntimeMigrationRepository(sql);
  const storage = createFakeDurableObjectState(database).storage;
  for (const migration of repository.migrations) {
    storage.transactionSync(() => migration(sql));
  }
  const logger = createLogger();
  const coordinator = new RuntimeMigrationCoordinator({
    repository,
    definitions,
    logger,
    now: options.now,
    retryPolicy: {
      baseDelayMs: options.retryDelayMs ?? 0,
      maxDelayMs: options.retryDelayMs ?? 0,
      operatorThreshold: 3,
    },
    ...(options.observe ? { observe: options.observe } : {}),
  });
  return { coordinator, repository, logger };
}

describe("RuntimeMigrationCoordinator", () => {
  it("applies a missing version, skips equal state, and skips a higher rollback version", async () => {
    const applyVersionTwo = vi.fn(async () => success(undefined));
    const versionTwo = defineVersionedRuntimeMigration({
      id: "fixture.version",
      description: "Fixture version",
      buildContext: () => null,
      version: 2,
      apply: applyVersionTwo,
    });
    const fixture = createFixture([versionTwo]);

    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "current" },
    });

    const applyVersionOne = vi.fn(async () => success(undefined));
    const rollbackEvents: RuntimeMigrationLifecycleEvent[] = [];
    const rolledBack = new RuntimeMigrationCoordinator({
      repository: fixture.repository,
      definitions: [defineVersionedRuntimeMigration({
        id: "fixture.version",
        description: "Fixture version",
        buildContext: () => null,
        version: 1,
        apply: applyVersionOne,
      })],
      logger: createLogger(),
      observe: (event) => rollbackEvents.push(event),
    });
    expect(await rolledBack.ensureMigrations(createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "current" },
    });
    expect(applyVersionTwo).toHaveBeenCalledOnce();
    expect(applyVersionOne).not.toHaveBeenCalled();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      "Runtime migration lifecycle event",
      {
        fields: expect.objectContaining({
          event: "applied",
          revision: 2,
          appliedRevision: 2,
        }),
      },
    );
    expect(fixture.logger.info).toHaveBeenCalledWith(
      "Runtime migration lifecycle event",
      {
        fields: {
          event: "current",
          migrationId: "fixture.version",
          revisionKind: "version",
          revision: 2,
        },
      },
    );
    expect(rollbackEvents).toContainEqual(expect.objectContaining({
      event: "newer_version_skipped",
      migrationId: "fixture.version",
      revision: 1,
      appliedRevision: 2,
    }));
  });

  it("reapplies a contract when its desired value changes", async () => {
    let revision = 1;
    const apply = vi.fn(async () => success(undefined));
    const definition = defineContractRuntimeMigration({
      id: "fixture.contract",
      description: "Fixture contract",
      buildContext: () => null,
      buildContract: () => ({ revision }),
      apply,
    });
    const { coordinator } = createFixture([definition]);

    await coordinator.ensureMigrations(createMigrationHost(), lease);
    revision = 2;
    expect(await coordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale attempted contract with the newly prepared revision", async () => {
    const desired = { revision: 2 } as const;
    const apply = vi.fn(async (input) => {
      expect(input.desired).toBe(desired);
      return success(undefined);
    });
    const definition = defineContractRuntimeMigration({
      id: "fixture.changed-attempt",
      description: "Changed attempt fixture",
      buildContext: () => null,
      buildContract: () => desired,
      apply,
    });
    const events: RuntimeMigrationLifecycleEvent[] = [];
    const fixture = createFixture([definition], {
      now: () => new Date("2026-08-01T00:01:00.000Z"),
      observe: (event) => events.push(event),
    });
    fixture.repository.beginAttempt(
      "fixture.changed-attempt",
      { kind: "contract", hash: "a".repeat(64) },
      "2026-08-01T00:00:00.000Z",
    );

    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    const record = fixture.repository.get("fixture.changed-attempt", "contract");
    expect(record.ok && record.value?.attemptedRevision).not.toEqual({
      kind: "contract",
      hash: "a".repeat(64),
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "interrupted_retry",
      migrationId: "fixture.changed-attempt",
      attempt: 2,
    }));
  });

  it("runs targeted prefixes serially and propagates aggregate applied", async () => {
    const calls: string[] = [];
    const first = defineVersionedRuntimeMigration({
      id: "fixture.first",
      description: "First fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => {
        calls.push("first");
        return success(undefined);
      },
    });
    const second = defineVersionedRuntimeMigration({
      id: "fixture.second",
      description: "Second fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => {
        calls.push("second");
        return success(undefined);
      },
    });
    const third = defineVersionedRuntimeMigration({
      id: "fixture.third",
      description: "Third fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => {
        calls.push("third");
        return success(undefined);
      },
    });
    const { coordinator } = createFixture([first, second, third]);

    expect(await coordinator.ensureMigration("fixture.second", createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(calls).toEqual(["first", "second"]);
    expect(await coordinator.ensureMigration("fixture.third", createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("defers the complete range before preparation or record reads", async () => {
    const definition = defineContractRuntimeMigration({
      id: "fixture.deferred",
      description: "Deferred fixture",
      buildContext: () => null,
      buildContract: vi.fn(() => ({ revision: 1 })),
      apply: async () => success(undefined),
    });
    const fixture = createFixture([definition]);
    const prepare = vi.spyOn(definition, "prepare");
    const get = vi.spyOn(fixture.repository, "get");

    expect(await fixture.coordinator.ensureMigrations(
      createMigrationHost({ activeUserMessageId: "message-1" }),
      lease,
    )).toEqual({ ok: true, value: { outcome: "deferred_active_turn" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("stops the range on failure and retains the prior applied revision", async () => {
    const first = defineVersionedRuntimeMigration({
      id: "fixture.failure",
      description: "Failure fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => success(undefined),
    });
    const laterApply = vi.fn(async () => success(undefined));
    const later = defineVersionedRuntimeMigration({
      id: "fixture.later",
      description: "Later fixture",
      buildContext: () => null,
      version: 1,
      apply: laterApply,
    });
    const fixture = createFixture([first, later]);
    await fixture.coordinator.ensureMigrations(createMigrationHost(), lease);
    laterApply.mockClear();

    const failing = defineVersionedRuntimeMigration({
      id: "fixture.failure",
      description: "Failure fixture",
      buildContext: () => null,
      version: 2,
      apply: async () => failure({
        code: "APPLY_FAILED",
        message: "unsafe integration output",
      }),
    });
    const failingCoordinator = new RuntimeMigrationCoordinator({
      repository: fixture.repository,
      definitions: [failing, later],
      logger: createLogger(),
      retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, operatorThreshold: 3 },
    });
    expect(await failingCoordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: false,
      error: { code: "APPLY_FAILED" },
    });
    expect(laterApply).not.toHaveBeenCalled();
    expect(fixture.repository.get("fixture.failure", "version")).toMatchObject({
      ok: true,
      value: {
        appliedRevision: { kind: "version", version: 1 },
        attemptedRevision: { kind: "version", version: 2 },
        status: "failed",
      },
    });
  });

  it.each([
    { stage: "before_attempt", completedEffects: 0, recordRunning: false, recordApplied: false },
    { stage: "after_attempt", completedEffects: 0, recordRunning: true, recordApplied: false },
    { stage: "after_effect_one", completedEffects: 1, recordRunning: true, recordApplied: false },
    { stage: "after_verification", completedEffects: 2, recordRunning: true, recordApplied: false },
    { stage: "after_applied_write", completedEffects: 2, recordRunning: true, recordApplied: true },
  ])("recovers the generic crash boundary at $stage", async (scenario) => {
    let completedEffects = scenario.completedEffects;
    const apply = vi.fn(async () => {
      while (completedEffects < 2) {
        completedEffects += 1;
      }
      return completedEffects === 2
        ? success(undefined)
        : failure({ code: "APPLY_FAILED", message: "Verification failed" });
    });
    const definition = defineVersionedRuntimeMigration({
      id: "fixture.crash",
      description: "Crash fixture",
      buildContext: () => null,
      version: 1,
      apply,
    });
    const fixture = createFixture([definition], {
      now: () => new Date("2026-08-01T00:01:00.000Z"),
    });
    const revision = { kind: "version", version: 1 } as const;
    if (scenario.recordRunning) {
      fixture.repository.beginAttempt(
        "fixture.crash",
        revision,
        "2026-08-01T00:00:00.000Z",
      );
    }
    if (scenario.recordApplied) {
      fixture.repository.markApplied(
        "fixture.crash",
        revision,
        "2026-08-01T00:00:01.000Z",
      );
    }

    const result = await fixture.coordinator.ensureMigrations(createMigrationHost(), lease);
    expect(result.ok).toBe(true);
    expect(completedEffects).toBe(2);
    expect(apply).toHaveBeenCalledTimes(scenario.recordApplied ? 0 : 1);
    expect(fixture.repository.get("fixture.crash", "version")).toMatchObject({
      ok: true,
      value: { status: "applied", appliedRevision: revision },
    });
  });

  it("enforces retry backoff and reports teardown before starting work", async () => {
    const definition = defineVersionedRuntimeMigration({
      id: "fixture.retry",
      description: "Retry fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => success(undefined),
    });
    const fixture = createFixture([definition], {
      now: () => new Date("2026-08-01T00:00:00.500Z"),
      retryDelayMs: 1_000,
    });
    const revision = { kind: "version", version: 1 } as const;
    fixture.repository.beginAttempt("fixture.retry", revision, "2026-08-01T00:00:00.000Z");
    fixture.repository.markFailed("fixture.retry", revision, {
      code: "APPLY_FAILED",
      message: "Safe failure",
    });

    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_RETRY_BACKOFF" },
    });
    expect(await fixture.coordinator.ensureMigrations(
      createMigrationHost({ teardownStarted: true }),
      lease,
    )).toMatchObject({ ok: false, error: { code: "SESSION_TEARDOWN_STARTED" } });
  });

  it("keeps contract preimages, secrets, and integration output out of records and logs", async () => {
    const secret = "raw-secret-never-log-this";
    const fingerprint = await fingerprintHighEntropySecret(secret);
    const definition = defineContractRuntimeMigration({
      id: "fixture.secret-safe",
      description: "Secret-safe fixture",
      buildContext: () => null,
      buildContract: () => ({ fingerprint, label: "private-contract-preimage" }),
      apply: async () => failure({
        code: "APPLY_FAILED",
        message: `stdout included ${secret}`,
      }),
    });
    const fixture = createFixture([definition]);
    await fixture.coordinator.ensureMigrations(createMigrationHost(), lease);

    const serializedLogs = JSON.stringify(fixture.logger.calls);
    const serializedRecords = JSON.stringify(
      fixture.repository.get("fixture.secret-safe", "contract"),
    );
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain("private-contract-preimage");
    expect(serializedRecords).not.toContain(secret);
    expect(serializedRecords).not.toContain("private-contract-preimage");
  });

  it("retires a superseded recurring contract without reinstalling legacy state", async () => {
    let externalState = "legacy";
    const legacy = defineContractRuntimeMigration({
      id: "fixture.recurring",
      description: "Recurring fixture",
      buildContext: () => null,
      buildContract: () => ({ desired: "legacy" }),
      apply: async () => {
        externalState = "legacy";
        return success(undefined);
      },
    });
    const fixture = createFixture([legacy]);
    await fixture.coordinator.ensureMigrations(createMigrationHost(), lease);

    const retiredApply = vi.fn(async () => {
      externalState = "absent";
      return success(undefined);
    });
    const retired = defineContractRuntimeMigration({
      id: "fixture.recurring",
      description: "Recurring fixture",
      buildContext: () => null,
      buildContract: () => ({ desired: "retired" }),
      apply: retiredApply,
    });
    const replacement = defineVersionedRuntimeMigration({
      id: "fixture.replacement",
      description: "Replacement fixture",
      buildContext: () => null,
      version: 1,
      apply: async () => {
        externalState = "replacement";
        return success(undefined);
      },
    });
    const coordinator = new RuntimeMigrationCoordinator({
      repository: fixture.repository,
      definitions: [retired, replacement],
      logger: createLogger(),
    });

    await coordinator.ensureMigrations(createMigrationHost(), lease);
    await coordinator.ensureMigrations(createMigrationHost(), lease);
    expect(externalState).toBe("replacement");
    expect(retiredApply).toHaveBeenCalledOnce();
  });

  it("lets a late-waking session skip newer version history and converge current contracts", async () => {
    const versionApply = vi.fn(async () => success(undefined));
    let externalContractState = "old";
    const versioned = defineVersionedRuntimeMigration({
      id: "fixture.late-version",
      description: "Late version fixture",
      buildContext: () => null,
      version: 1,
      apply: versionApply,
    });
    const contract = defineContractRuntimeMigration({
      id: "fixture.late-contract",
      description: "Late contract fixture",
      buildContext: () => null,
      buildContract: () => ({ desired: "current" }),
      apply: async () => {
        externalContractState = "current";
        return success(undefined);
      },
    });
    const fixture = createFixture([versioned, contract]);
    const newerVersion = { kind: "version", version: 2 } as const;
    fixture.repository.beginAttempt(
      "fixture.late-version",
      newerVersion,
      "2026-08-01T00:00:00.000Z",
    );
    fixture.repository.markApplied(
      "fixture.late-version",
      newerVersion,
      "2026-08-01T00:00:01.000Z",
    );
    const oldContract = { kind: "contract", hash: "a".repeat(64) } as const;
    fixture.repository.beginAttempt(
      "fixture.late-contract",
      oldContract,
      "2026-08-01T00:00:00.000Z",
    );
    fixture.repository.markApplied(
      "fixture.late-contract",
      oldContract,
      "2026-08-01T00:00:01.000Z",
    );

    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(versionApply).not.toHaveBeenCalled();
    expect(externalContractState).toBe("current");
  });

  it("reconciles the prior desired contract on compatible application rollback", async () => {
    let externalState = "unknown";
    const current = defineContractRuntimeMigration({
      id: "fixture.rollback-contract",
      description: "Rollback contract fixture",
      buildContext: () => null,
      buildContract: () => ({ desired: "new" }),
      apply: async () => {
        externalState = "new";
        return success(undefined);
      },
    });
    const fixture = createFixture([current]);
    await fixture.coordinator.ensureMigrations(createMigrationHost(), lease);

    const rolledBack = defineContractRuntimeMigration({
      id: "fixture.rollback-contract",
      description: "Rollback contract fixture",
      buildContext: () => null,
      buildContract: () => ({ desired: "old" }),
      apply: async () => {
        externalState = "old";
        return success(undefined);
      },
    });
    const rollbackCoordinator = new RuntimeMigrationCoordinator({
      repository: fixture.repository,
      definitions: [rolledBack],
      logger: createLogger(),
    });

    expect(await rollbackCoordinator.ensureMigrations(createMigrationHost(), lease)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(externalState).toBe("old");
  });

  it("ships an empty registry as a local no-op with no records", async () => {
    const fixture = createFixture([]);
    const beginAttempt = vi.spyOn(fixture.repository, "beginAttempt");
    expect(await fixture.coordinator.ensureMigrations(createMigrationHost(), lease)).toEqual({
      ok: true,
      value: { outcome: "current" },
    });
    expect(beginAttempt).not.toHaveBeenCalled();
  });
});
