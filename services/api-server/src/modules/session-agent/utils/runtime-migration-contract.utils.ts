import { sha256 } from "@/shared/utils/crypto";
import type {
  JsonValue,
  RuntimeMigrationRevision,
} from "@/modules/session-agent/types/runtime-migration.types";

const CONTRACT_HASH_DOMAIN = "runtime-migration-contract:v1";
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SecretFingerprint {
  readonly algorithm: "sha256";
  readonly digest: string;
}

export interface DurableSecretVersion {
  readonly strategy: "durable_version";
  readonly version: string;
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Runtime migration contracts require finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Runtime migration contracts require JSON values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Runtime migration contracts cannot contain cycles");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Runtime migration contracts cannot contain symbol keys");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) {
        throw new TypeError("Runtime migration contract arrays cannot be sparse");
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError("Runtime migration contract arrays require plain values");
        }
        entries.push(canonicalize(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Runtime migration contracts require plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError("Runtime migration contracts cannot contain accessors");
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Returns deterministic JSON after rejecting values JSON would silently coerce. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

/** Hashes a contract with a versioned, migration-ID-specific domain separator. */
export async function hashRuntimeMigrationContract(
  migrationId: string,
  contract: JsonValue,
): Promise<string> {
  return sha256(`${CONTRACT_HASH_DOMAIN}\n${migrationId}\n${canonicalJson(contract)}`);
}

/** Fingerprints a high-entropy secret without retaining the source value. */
export async function fingerprintHighEntropySecret(secret: string): Promise<SecretFingerprint> {
  return { algorithm: "sha256", digest: await sha256(secret) };
}

/** Uses an authority-owned revision instead of hashing a low-entropy secret. */
export function durableSecretVersion(version: string): DurableSecretVersion {
  if (version.length === 0) {
    throw new TypeError("A durable secret version cannot be empty");
  }
  return { strategy: "durable_version", version };
}

export function serializeRuntimeMigrationRevision(revision: RuntimeMigrationRevision): string {
  switch (revision.kind) {
    case "version":
      return JSON.stringify({ kind: revision.kind, version: revision.version });
    case "contract":
      return JSON.stringify({ kind: revision.kind, hash: revision.hash });
  }
}

export function isSha256Digest(value: string): boolean {
  return HEX_SHA256_PATTERN.test(value);
}
