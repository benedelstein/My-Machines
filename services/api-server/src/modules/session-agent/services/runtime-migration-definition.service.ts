import { failure, success, type Result } from "@repo/shared";
import type {
  JsonValue,
  RuntimeMigrationApplyInput,
  RuntimeMigrationContext,
  RuntimeMigrationDefinition,
  RuntimeMigrationError,
  RuntimeMigrationRevisionKind,
} from "@/modules/session-agent/types/runtime-migration.types";
import { hashRuntimeMigrationContract } from
  "@/modules/session-agent/utils/runtime-migration-contract.utils";

interface RuntimeMigrationDefinitionBase<Desired extends JsonValue> {
  readonly id: string;
  readonly description: string;
  readonly apply: (
    input: RuntimeMigrationApplyInput<Desired>,
  ) => Promise<Result<void, RuntimeMigrationError>>;
}

interface VersionedRuntimeMigrationDefinitionArgs extends
  RuntimeMigrationDefinitionBase<{ readonly version: number }> {
  readonly version: number;
}

interface ContractRuntimeMigrationDefinitionArgs<Contract extends JsonValue> extends
  RuntimeMigrationDefinitionBase<Contract> {
  readonly buildContract: (
    context: RuntimeMigrationContext,
  ) => Contract | Promise<Contract>;
}

function validateDefinitionIdentity(id: string, description: string): void {
  if (id.trim().length === 0) {
    throw new TypeError("Runtime migration IDs cannot be empty");
  }
  if (description.trim().length === 0) {
    throw new TypeError("Runtime migration descriptions cannot be empty");
  }
}

/** Declares a forward-only revision scoped to one stable migration ID. */
export function defineVersionedRuntimeMigration(
  args: VersionedRuntimeMigrationDefinitionArgs,
): RuntimeMigrationDefinition {
  validateDefinitionIdentity(args.id, args.description);
  if (!Number.isSafeInteger(args.version) || args.version <= 0) {
    throw new TypeError("Runtime migration versions must be positive safe integers");
  }

  return {
    id: args.id,
    description: args.description,
    revisionKind: "version",
    prepare: async (context) => {
      const desired = { version: args.version } as const;
      const revision = { kind: "version", version: args.version } as const;
      return success({
        revision,
        apply: (attempt) => args.apply({ context, desired, revision, attempt }),
      });
    },
  };
}

/** Declares desired state whose revision is built and hashed at readiness time. */
export function defineContractRuntimeMigration<Contract extends JsonValue>(
  args: ContractRuntimeMigrationDefinitionArgs<Contract>,
): RuntimeMigrationDefinition {
  validateDefinitionIdentity(args.id, args.description);

  return {
    id: args.id,
    description: args.description,
    revisionKind: "contract",
    prepare: async (context) => {
      try {
        const desired = await args.buildContract(context);
        const revision = {
          kind: "contract",
          hash: await hashRuntimeMigrationContract(args.id, desired),
        } as const;
        return success({
          revision,
          apply: (attempt) => args.apply({ context, desired, revision, attempt }),
        });
      } catch {
        return failure({
          code: "PREPARATION_FAILED",
          message: "Runtime migration desired state could not be prepared",
          migrationId: args.id,
        });
      }
    },
  };
}

/** Fails startup when IDs collide or a pinned ID changes revision strategy. */
export function assertRuntimeMigrationRegistry(
  definitions: readonly RuntimeMigrationDefinition[],
  pinnedRevisionKinds: Readonly<Record<string, RuntimeMigrationRevisionKind>> = {},
): void {
  const observed = new Map<string, RuntimeMigrationRevisionKind>();
  for (const definition of definitions) {
    validateDefinitionIdentity(definition.id, definition.description);
    const previousKind = observed.get(definition.id);
    if (previousKind) {
      const suffix = previousKind === definition.revisionKind
        ? "is registered more than once"
        : "changes revision strategy within the registry";
      throw new Error(`Runtime migration ${definition.id} ${suffix}`);
    }
    const pinnedKind = pinnedRevisionKinds[definition.id];
    if (pinnedKind && pinnedKind !== definition.revisionKind) {
      throw new Error(`Runtime migration ${definition.id} changes its pinned revision strategy`);
    }
    observed.set(definition.id, definition.revisionKind);
  }
}
