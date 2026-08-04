import { describe, expect, it, vi } from "vitest";
import { failure, success } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { RuntimeMigrationRepository } from
  "../../src/modules/session-agent/repositories/runtime-migration.repository";
import { RuntimeMigrationCoordinator } from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-coordinator.service";
import {
  startupToolchainRuntimeMigration,
  type StartupToolchainRuntimeMigrationContext,
} from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain-runtime-migration.service";
import type { RuntimeBoundaryLease } from
  "../../src/modules/session-agent/types/runtime-boundary.types";
import {
  buildLegacyStartupToolchainContractHash,
  buildStartupToolchainContract,
  type StartupToolchainCheck,
} from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service";
import type { StartupToolchainCheckpoint } from
  "../../src/modules/session-agent/types/startup-toolchain.types";
import {
  createFakeDurableObjectState,
  createSqlFn,
  createTestDatabase,
} from "./session-agent-do-harness";
import { createTestLogger } from "./test-logger";

const lease = {} as RuntimeBoundaryLease;

function createFixture() {
  const database = createTestDatabase();
  const sql = createSqlFn(database);
  const repository = new RuntimeMigrationRepository(sql);
  const storage = createFakeDurableObjectState(database).storage;
  for (const migration of repository.migrations) {
    storage.transactionSync(() => migration(sql));
  }
  const coordinator = new RuntimeMigrationCoordinator({
    repository,
    definitions: [startupToolchainRuntimeMigration],
    logger: createTestLogger(),
    retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, operatorThreshold: 3 },
  });
  return { coordinator, repository };
}

function createCheck(revision: string): StartupToolchainCheck {
  return {
    id: "fixture.tool",
    contract: {
      id: "fixture.tool",
      minimumVersion: revision,
      scriptVersion: revision,
      script: `ensure fixture ${revision}`,
    },
    ensureReady: vi.fn(async () => success({
      id: "fixture.tool",
      status: "ready" as const,
      requiredVersion: revision,
    })),
  };
}

function createContext(args: {
  check: StartupToolchainCheck;
  checkpoint?: StartupToolchainCheckpoint | null;
  activeUserMessageId?: string | null;
  updateCheckpoint?: (checkpoint: StartupToolchainCheckpoint) => void;
}): StartupToolchainRuntimeMigrationContext {
  const contract = buildStartupToolchainContract("openai-codex", [args.check]);
  const getPrepared = vi.fn(() => ({ contract, checks: [args.check] }));
  return {
    getServerState: () => ({
      activeUserMessageId: args.activeUserMessageId ?? null,
    }),
    isTeardownStarted: () => false,
    startupToolchain: {
      getPrepared,
      sprite: {} as WorkersSpriteClient,
      checkpoint: args.checkpoint ?? null,
      logger: createTestLogger(),
      updateCheckpoint: args.updateCheckpoint ?? (() => {}),
    },
  };
}

describe("startup toolchain runtime migration", () => {
  it("adopts a matching legacy checkpoint with zero Sprite checks", async () => {
    const check = createCheck("1");
    const contract = buildStartupToolchainContract("openai-codex", [check]);
    const checkpoint = {
      contractHash: await buildLegacyStartupToolchainContractHash(contract),
      checkedAt: 1,
      results: [],
    };
    const updateCheckpoint = vi.fn();
    const { coordinator, repository } = createFixture();

    expect(await coordinator.ensureMigrations(createContext({
      check,
      checkpoint,
      updateCheckpoint,
    }), lease)).toEqual({ ok: true, value: { outcome: "applied" } });

    expect(check.ensureReady).not.toHaveBeenCalled();
    expect(updateCheckpoint).not.toHaveBeenCalled();
    expect(repository.get("sprite.startup-toolchain", "contract")).toMatchObject({
      ok: true,
      value: { status: "applied", attemptCount: 1 },
    });
  });

  it("repairs changed desired inputs, checkpoints them, then skips locally", async () => {
    const firstCheck = createCheck("1");
    const secondCheck = createCheck("2");
    const updateCheckpoint = vi.fn();
    const { coordinator } = createFixture();

    await coordinator.ensureMigrations(createContext({
      check: firstCheck,
      updateCheckpoint,
    }), lease);
    await coordinator.ensureMigrations(createContext({
      check: secondCheck,
      updateCheckpoint,
    }), lease);
    await coordinator.ensureMigrations(createContext({
      check: secondCheck,
      updateCheckpoint,
    }), lease);

    expect(firstCheck.ensureReady).toHaveBeenCalledOnce();
    expect(secondCheck.ensureReady).toHaveBeenCalledOnce();
    expect(updateCheckpoint).toHaveBeenCalledTimes(2);
  });

  it("records a failed check and retries the idempotent check", async () => {
    const check = createCheck("1");
    vi.mocked(check.ensureReady)
      .mockResolvedValueOnce(failure({
        domain: "startup_toolchain",
        code: "CHECK_FAILED",
        message: "fixture failed",
        checkId: "fixture.tool",
      }))
      .mockResolvedValueOnce(success({
        id: "fixture.tool",
        status: "ready",
        requiredVersion: "1",
      }));
    const { coordinator, repository } = createFixture();
    const context = createContext({ check });

    expect(await coordinator.ensureMigrations(context, lease)).toMatchObject({
      ok: false,
      error: { code: "APPLY_FAILED" },
    });
    expect(repository.get("sprite.startup-toolchain", "contract")).toMatchObject({
      ok: true,
      value: { status: "failed", attemptCount: 1 },
    });
    expect(await coordinator.ensureMigrations(context, lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(check.ensureReady).toHaveBeenCalledTimes(2);
  });

  it("adopts the verified checkpoint when recording applied state is interrupted", async () => {
    const check = createCheck("1");
    const { coordinator, repository } = createFixture();
    let checkpoint: StartupToolchainCheckpoint | null = null;
    const originalMarkApplied = repository.markApplied.bind(repository);
    vi.spyOn(repository, "markApplied")
      .mockReturnValueOnce(failure({
        code: "MIGRATION_REPOSITORY_WRITE_FAILED",
        message: "simulated Worker stop before applied write",
        migrationId: "sprite.startup-toolchain",
      }))
      .mockImplementation(originalMarkApplied);
    const updateCheckpoint = (nextCheckpoint: StartupToolchainCheckpoint) => {
      checkpoint = nextCheckpoint;
    };

    expect(await coordinator.ensureMigrations(createContext({
      check,
      checkpoint,
      updateCheckpoint,
    }), lease)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_REPOSITORY_WRITE_FAILED" },
    });
    expect(await coordinator.ensureMigrations(createContext({
      check,
      checkpoint,
      updateCheckpoint,
    }), lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(check.ensureReady).toHaveBeenCalledOnce();
  });

  it("defers the entire adopter before a Sprite check while a turn is active", async () => {
    const check = createCheck("1");
    const { coordinator, repository } = createFixture();
    const context = createContext({
      check,
      activeUserMessageId: "message-1",
    });

    expect(await coordinator.ensureMigrations(context, lease)).toEqual({
      ok: true,
      value: { outcome: "deferred_active_turn" },
    });
    expect(context.startupToolchain.getPrepared).not.toHaveBeenCalled();
    expect(check.ensureReady).not.toHaveBeenCalled();
    expect(repository.get("sprite.startup-toolchain", "contract"))
      .toEqual({ ok: true, value: null });
  });
});
