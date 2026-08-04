import { describe, expect, it, vi } from "vitest";
import { success } from "@repo/shared";
import {
  assertRuntimeMigrationRegistry,
  defineContractRuntimeMigration,
  defineVersionedRuntimeMigration,
} from "../../src/modules/session-agent/services/runtime-migration/runtime-migration-definition.service";
import type { RuntimeMigrationContext } from
  "../../src/modules/session-agent/types/runtime-migration.types";
import {
  canonicalJson,
  durableSecretVersion,
  fingerprintHighEntropySecret,
  hashRuntimeMigrationContract,
} from "../../src/modules/session-agent/utils/runtime-migration-contract.utils";

const context: RuntimeMigrationContext = {
  getServerState: () => ({ activeUserMessageId: null }),
  isTeardownStarted: () => false,
};

describe("runtime migration contracts", () => {
  it("canonicalizes nested objects while preserving array order and JSON scalars", () => {
    const left = {
      z: ["é", null, 4, true],
      a: { second: "two", first: "one" },
    };
    const right = {
      a: { first: "one", second: "two" },
      z: ["é", null, 4, true],
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(-0)).toBe("0");
  });

  it.each([
    undefined,
    () => undefined,
    Symbol("invalid"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(),
    new Map(),
    new Set(),
    1n,
    Object.assign(Object.create({ inherited: true }) as object, { value: 1 }),
  ])("rejects non-JSON contract input %#", (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("rejects cyclic and sparse structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "present";

    expect(() => canonicalJson(cyclic)).toThrow(/cycles/u);
    expect(() => canonicalJson(sparse)).toThrow(/sparse/u);
  });

  it("domain-separates contract hashes by migration ID", async () => {
    const contract = { revision: 1, values: ["a", "b"] } as const;
    const first = await hashRuntimeMigrationContract("first", contract);
    const reordered = await hashRuntimeMigrationContract("first", {
      values: ["a", "b"],
      revision: 1,
    });
    const second = await hashRuntimeMigrationContract("second", contract);

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(second).not.toBe(first);
  });

  it("fingerprints high-entropy secrets and supports durable low-entropy versions", async () => {
    const secret = "secret-value-that-must-not-survive";
    const first = await fingerprintHighEntropySecret(secret);
    const second = await fingerprintHighEntropySecret(`${secret}-rotated`);

    expect(first.digest).not.toContain(secret);
    expect(second.digest).not.toBe(first.digest);
    expect(await hashRuntimeMigrationContract("fixture.secret", {
      fingerprint: first,
      otherInputs: { revision: 1 },
    })).not.toBe(await hashRuntimeMigrationContract("fixture.secret", {
      fingerprint: second,
      otherInputs: { revision: 1 },
    }));
    expect(durableSecretVersion("credential-v2")).toEqual({
      strategy: "durable_version",
      version: "credential-v2",
    });
  });

  it("passes the exact runtime-built contract instance to apply", async () => {
    const desired = { nested: { value: "same-instance" } } as const;
    const apply = vi.fn(async (input) => {
      expect(input.desired).toBe(desired);
      return success(undefined);
    });
    const definition = defineContractRuntimeMigration({
      id: "fixture.contract",
      description: "Fixture contract",
      buildContract: () => desired,
      apply,
    });

    const prepared = await definition.prepare(context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    await prepared.value.apply(1);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("validates version declarations and registry invariants", () => {
    const versioned = defineVersionedRuntimeMigration({
      id: "fixture.versioned",
      description: "Fixture version",
      version: 1,
      apply: async () => success(undefined),
    });

    expect(() => defineVersionedRuntimeMigration({
      id: "fixture.invalid",
      description: "Invalid version",
      version: 0,
      apply: async () => success(undefined),
    })).toThrow(/positive safe integers/u);
    expect(() => assertRuntimeMigrationRegistry([versioned, versioned])).toThrow(/more than once/u);
    expect(() => assertRuntimeMigrationRegistry(
      [versioned],
      { "fixture.versioned": "contract" },
    )).toThrow(/pinned revision strategy/u);
  });
});
