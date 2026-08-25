import { describe, expect, it, vi } from "vitest";
import { SpritesError, type WorkersSpriteClient } from "@repo/sprites-client";
import { RUNTIME_MIGRATIONS } from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-registry";
import { sessionConnectorRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/session-connector-runtime-migration.service";
import { sessionSpriteLabelsRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/session-sprite-labels-runtime-migration.service";
import { gitEphemeralTokenRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/git-ephemeral-token-runtime-migration.service";
import { networkPolicyRuntimeMigration } from
  "../../src/modules/session-agent/services/runtime-migration/network-policy-runtime-migration.service";
import { createMigrationDependencies } from "./runtime-migration-test-support";
import { hashRuntimeMigrationContract } from
  "../../src/modules/session-agent/utils/runtime-migration-contract.utils";

describe("Phase 5 runtime migrations", () => {
  it("pins the exact five-entry registry without the reusable process adopter", () => {
    expect(RUNTIME_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "sprite.startup-toolchain",
      "sprite.session-labels",
      "session.connector-resource",
      "sprite.git-ephemeral-token-cutover",
      "sprite.network-policy",
    ]);
    expect(RUNTIME_MIGRATIONS.some((migration) => migration.id === "agent.reusable-process"))
      .toBe(false);
  });

  it("derives and reconciles the exact Sprite label contract independently", async () => {
    const dependencies = createMigrationDependencies({
      environmentSnapshot: {
        ...createMigrationDependencies().getEnvironmentSnapshot(),
        sourceEnvironmentId: "environment-1",
      },
    });
    const prepared = await sessionSpriteLabelsRuntimeMigration.prepare(dependencies);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(await prepared.value.apply(2)).toEqual({ ok: true, value: undefined });
    expect(dependencies.reconcileSessionSpriteLabels).toHaveBeenCalledWith({
      contractSchema: 1,
      labels: ["session:session-1", "env:environment-1"],
    });
    const contract = vi.mocked(dependencies.reconcileSessionSpriteLabels).mock.calls[0]?.[0];
    expect(prepared.value.revision).toEqual({
      kind: "contract",
      hash: await hashRuntimeMigrationContract("sprite.session-labels", contract!),
    });
    await expect(hashRuntimeMigrationContract("sprite.session-labels", {
      ...contract!,
      labels: ["session:session-1"],
    })).resolves.not.toBe(
      prepared.value.revision.kind === "contract" ? prepared.value.revision.hash : "",
    );
  });

  it("builds connector desired state without allocated identity or webhook credentials", async () => {
    const dependencies = createMigrationDependencies({
      serverState: { sessionConnectorId: "allocated-connector-id" },
    });
    const prepared = await sessionConnectorRuntimeMigration.prepare(dependencies);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.value.revision.kind).toBe("contract");
    expect(await prepared.value.apply(3)).toEqual({ ok: true, value: undefined });
    expect(dependencies.reconcileSessionConnector).toHaveBeenCalledWith({
      contract: {
        contractSchema: 1,
        provider: "custom_api",
        baseApiUrl: "https://worker.test",
        testUrl: "https://worker.test/health",
        accessPolicy: {
          allowedEndpoints: [
            "/internal/session/session-1/chunks",
            "/internal/session/session-1/events",
            "/internal/session/session-1/git-token",
            "/health",
          ],
          blockedEndpoints: [],
        },
      },
    });
    const reconcileInput = vi.mocked(dependencies.reconcileSessionConnector).mock.calls[0]?.[0];
    expect(prepared.value.revision).toEqual({
      kind: "contract",
      hash: await hashRuntimeMigrationContract(
        "session.connector-resource",
        reconcileInput!.contract,
      ),
    });
    const contract = reconcileInput!.contract;
    const variants = [
      { ...contract, provider: "other_provider" },
      { ...contract, baseApiUrl: "https://different-worker.test" },
      { ...contract, testUrl: "https://worker.test/different-health" },
      {
        ...contract,
        accessPolicy: {
          ...contract.accessPolicy,
          allowedEndpoints: [...contract.accessPolicy.allowedEndpoints, "/changed"],
        },
      },
      {
        ...contract,
        accessPolicy: {
          ...contract.accessPolicy,
          blockedEndpoints: ["/changed"],
        },
      },
    ];
    const originalHash = prepared.value.revision.kind === "contract"
      ? prepared.value.revision.hash
      : "";
    for (const variant of variants) {
      await expect(hashRuntimeMigrationContract("session.connector-resource", variant))
        .resolves.not.toBe(originalHash);
    }
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
    const setNetworkPolicy = vi.fn(async () => {});
    const lockedDependencies = createMigrationDependencies({
      sprite: { setNetworkPolicy } as unknown as WorkersSpriteClient,
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
    expect(setNetworkPolicy).toHaveBeenCalledOnce();
    expect(setNetworkPolicy).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ domain: "worker.test", action: "allow" }),
      expect.objectContaining({ domain: "*", action: "deny" }),
    ]));
    expect(lockedDependencies.updateServerState)
      .toHaveBeenCalledWith({ finalNetworkPolicyApplied: true });
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
