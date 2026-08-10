import { describe, expect, it, vi } from "vitest";
import { SpritesError } from "@repo/sprites-client";
import { RUNTIME_MIGRATIONS } from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-registry.service";
import { sessionConnectorRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/session-connector-runtime-migration.service";
import { gitEphemeralTokenRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/git-ephemeral-token-runtime-migration.service";
import { networkPolicyRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/network-policy-runtime-migration.service";
import { createMigrationDependencies } from "./runtime-migration-test-support";

describe("Phase 5 runtime migrations", () => {
  it("pins the exact four-entry registry without the reusable process adopter", () => {
    expect(RUNTIME_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "sprite.startup-toolchain",
      "session.connector-resource",
      "sprite.git-ephemeral-token-cutover",
      "sprite.network-policy",
    ]);
    expect(RUNTIME_MIGRATIONS.some((migration) => migration.id === "agent.reusable-process"))
      .toBe(false);
  });

  it("builds connector desired state without allocated identity or webhook credentials", async () => {
    const dependencies = createMigrationDependencies({
      serverState: {
        sessionConnectorId: "allocated-connector-id",
        spriteLabelsApplied: true,
      },
    });
    const prepared = await sessionConnectorRuntimeMigration.prepare(dependencies);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.value.revision.kind).toBe("contract");
    expect(await prepared.value.apply(3)).toEqual({ ok: true, value: undefined });
    expect(dependencies.reconcileSessionConnector).toHaveBeenCalledWith({
      contract: expect.objectContaining({
        provider: "custom_api",
        baseApiUrl: "https://worker.test",
        requiredSpriteLabels: ["session:session-1"],
      }),
      desiredRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const reconcileInput = vi.mocked(dependencies.reconcileSessionConnector).mock.calls[0]?.[0];
    expect(JSON.stringify(reconcileInput?.contract)).not.toContain("allocated-connector-id");
    expect(JSON.stringify(reconcileInput?.contract)).not.toContain("webhook-token");
  });

  it("keeps Git cutover versioned and verifies it through its idempotent reconciler", async () => {
    const dependencies = createMigrationDependencies();
    const prepared = await gitEphemeralTokenRuntimeMigration.prepare(dependencies);

    expect(prepared).toMatchObject({
      ok: true,
      value: { revision: { kind: "version", version: 1 } },
    });
    if (!prepared.ok) {
      return;
    }
    expect(await prepared.value.apply(1)).toEqual({ ok: true, value: undefined });
    expect(dependencies.reconcileGitEphemeralTokenCutover).toHaveBeenCalledOnce();
  });

  it("derives network policy from the persisted snapshot and deployment inputs", async () => {
    const defaultDependencies = createMigrationDependencies();
    const lockedDependencies = createMigrationDependencies({
      environmentSnapshot: {
        ...defaultDependencies.getEnvironmentSnapshot(),
        network: { mode: "locked" },
      },
    });
    const defaultPrepared = await networkPolicyRuntimeMigration.prepare(defaultDependencies);
    const lockedPrepared = await networkPolicyRuntimeMigration.prepare(lockedDependencies);

    expect(defaultPrepared.ok && lockedPrepared.ok).toBe(true);
    if (!defaultPrepared.ok || !lockedPrepared.ok) {
      return;
    }
    expect(defaultPrepared.value.revision).not.toEqual(lockedPrepared.value.revision);
    expect(await lockedPrepared.value.apply(1)).toEqual({ ok: true, value: undefined });
    expect(lockedDependencies.reconcileNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedNetwork: { mode: "locked" },
        workerHostname: "worker.test",
        connectorGatewayHostname: "api.sprites.test",
      }),
    );
  });

  it("turns adopter exceptions into secret-safe migration failures", async () => {
    const dependencies = createMigrationDependencies();
    const warn = vi.spyOn(dependencies.logger, "warn");
    vi.mocked(dependencies.reconcileGitEphemeralTokenCutover)
      .mockRejectedValue(new SpritesError(
        "secret raw integration output",
        401,
        "secret provider body",
      ));
    const prepared = await gitEphemeralTokenRuntimeMigration.prepare(dependencies);
    if (!prepared.ok) {
      throw new Error("Git migration preparation failed unexpectedly");
    }

    expect(await prepared.value.apply(1)).toEqual({
      ok: false,
      error: {
        code: "APPLY_FAILED",
        message: "Ephemeral Git token cutover apply or verification failed",
        migrationId: "sprite.git-ephemeral-token-cutover",
      },
    });
    expect(warn).toHaveBeenCalledWith("Runtime migration adopter failed", {
      fields: {
        migrationId: "sprite.git-ephemeral-token-cutover",
        cause: "provider_authentication_failed",
      },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });
});
