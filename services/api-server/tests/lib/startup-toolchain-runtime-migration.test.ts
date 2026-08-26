import { beforeEach, describe, expect, it, vi } from "vitest";
import { failure, success } from "@repo/shared";
import { RuntimeMigrationRepository } from
  "../../src/modules/session-agent/repositories/runtime-migration.repository";
import { RuntimeMigrationCoordinator } from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-coordinator.service";
import { startupToolchainRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain-runtime-migration.service";
import type { RuntimeBoundaryLease } from
  "../../src/modules/session-agent/types/runtime-boundary.types";
import {
  buildLegacyStartupToolchainContractHash,
  buildStartupToolchainContract,
  prepareStartupToolchain,
  type StartupToolchainCheck,
} from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service";
import type { StartupToolchainCheckpoint } from
  "../../src/modules/session-agent/types/startup-toolchain.types";
import type * as StartupToolchainService from
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service";
import {
  createFakeDurableObjectState,
  createSqlFn,
  createTestDatabase,
} from "./session-agent-do-harness";
import { createMigrationDependencies } from "./runtime-migration-test-support";
import { createTestLogger } from "./test-logger";

const lease = {} as RuntimeBoundaryLease;

/**
 * The definition builds its own check set from the host, so the fixture check
 * is injected by stubbing the one factory it calls. Hashing and the apply path
 * stay real.
 */
const fixture = vi.hoisted(() => ({
  prepared: null as { contract: unknown; checks: unknown[] } | null,
}));

vi.mock(
  "../../src/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service",
  async (importOriginal) => {
    const actual = await importOriginal<typeof StartupToolchainService>();
    return {
      ...actual,
      prepareStartupToolchain: vi.fn(() => {
        if (!fixture.prepared) {
          throw new Error("Test did not install a prepared startup toolchain");
        }
        return fixture.prepared;
      }),
    };
  },
);

function createCoordinator() {
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

/** Installs the check set the definition will see on its next prepare. */
function installCheck(check: StartupToolchainCheck): void {
  fixture.prepared = {
    contract: buildStartupToolchainContract("openai-codex", [check]),
    checks: [check],
  };
}

async function legacyCheckpointFor(
  check: StartupToolchainCheck,
): Promise<StartupToolchainCheckpoint> {
  const contract = buildStartupToolchainContract("openai-codex", [check]);
  return {
    contractHash: await buildLegacyStartupToolchainContractHash(contract),
    checkedAt: 1,
    results: [],
  };
}

describe("startup toolchain runtime migration", () => {
  beforeEach(() => {
    vi.mocked(prepareStartupToolchain).mockClear();
  });

  it("adopts a matching legacy checkpoint with zero Sprite checks", async () => {
    const check = createCheck("1");
    installCheck(check);
    const host = createMigrationDependencies({
      serverState: { startupToolchain: await legacyCheckpointFor(check) },
    });
    const { coordinator, repository } = createCoordinator();

    expect(await coordinator.ensureMigrations(host, lease))
      .toEqual({ ok: true, value: { outcome: "applied" } });

    expect(check.ensureReady).not.toHaveBeenCalled();
    expect(host.updateServerState).not.toHaveBeenCalled();
    expect(repository.get("sprite.startup-toolchain", "contract")).toMatchObject({
      ok: true,
      value: { status: "applied", attemptCount: 1 },
    });
  });

  it("repairs changed desired inputs, checkpoints them, then skips locally", async () => {
    const firstCheck = createCheck("1");
    const secondCheck = createCheck("2");
    const host = createMigrationDependencies();
    const { coordinator } = createCoordinator();

    installCheck(firstCheck);
    await coordinator.ensureMigrations(host, lease);
    installCheck(secondCheck);
    await coordinator.ensureMigrations(host, lease);
    await coordinator.ensureMigrations(host, lease);

    expect(firstCheck.ensureReady).toHaveBeenCalledOnce();
    expect(secondCheck.ensureReady).toHaveBeenCalledOnce();
    expect(host.updateServerState).toHaveBeenCalledTimes(2);
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
    installCheck(check);
    const host = createMigrationDependencies();
    const { coordinator, repository } = createCoordinator();

    expect(await coordinator.ensureMigrations(host, lease)).toMatchObject({
      ok: false,
      error: { code: "APPLY_FAILED" },
    });
    expect(repository.get("sprite.startup-toolchain", "contract")).toMatchObject({
      ok: true,
      value: { status: "failed", attemptCount: 1 },
    });
    expect(await coordinator.ensureMigrations(host, lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(check.ensureReady).toHaveBeenCalledTimes(2);
  });

  it("adopts the verified checkpoint when recording applied state is interrupted", async () => {
    const check = createCheck("1");
    installCheck(check);
    const host = createMigrationDependencies();
    const { coordinator, repository } = createCoordinator();
    const originalMarkApplied = repository.markApplied.bind(repository);
    vi.spyOn(repository, "markApplied")
      .mockReturnValueOnce(failure({
        code: "MIGRATION_REPOSITORY_WRITE_FAILED",
        message: "simulated Worker stop before applied write",
        migrationId: "sprite.startup-toolchain",
      }))
      .mockImplementation(originalMarkApplied);

    expect(await coordinator.ensureMigrations(host, lease)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_REPOSITORY_WRITE_FAILED" },
    });
    expect(await coordinator.ensureMigrations(host, lease)).toEqual({
      ok: true,
      value: { outcome: "applied" },
    });
    expect(check.ensureReady).toHaveBeenCalledOnce();
  });

  it("defers the entire adopter before building its context while a turn is active", async () => {
    const check = createCheck("1");
    installCheck(check);
    const host = createMigrationDependencies({ activeUserMessageId: "message-1" });
    const { coordinator, repository } = createCoordinator();

    expect(await coordinator.ensureMigrations(host, lease)).toEqual({
      ok: true,
      value: { outcome: "deferred_active_turn" },
    });
    expect(host.createSpriteClient).not.toHaveBeenCalled();
    expect(vi.mocked(prepareStartupToolchain)).not.toHaveBeenCalled();
    expect(check.ensureReady).not.toHaveBeenCalled();
    expect(repository.get("sprite.startup-toolchain", "contract"))
      .toEqual({ ok: true, value: null });
  });
});
