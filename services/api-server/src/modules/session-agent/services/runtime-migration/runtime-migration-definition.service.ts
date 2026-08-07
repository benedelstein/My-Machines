import { failure, success, type Result } from "@repo/shared";
import type {
  JsonValue,
  RuntimeMigrationApplyInput,
  RuntimeMigrationDefinition,
  RuntimeMigrationError,
  RuntimeMigrationHost,
  RuntimeMigrationRevisionKind,
} from "@/modules/session-agent/types/runtime-migration.types";
import { hashRuntimeMigrationContract } from
  "@/modules/session-agent/utils/runtime-migration-contract.utils";

interface RuntimeMigrationDefinitionBase<
  Id extends string,
  Context,
  Desired extends JsonValue,
> {
  readonly id: Id;
  readonly description: string;
  /**
   * Builds everything this migration needs from the session. Called once per
   * `prepare`, after the coordinator's teardown and active-turn gates, so
   * dependencies are never constructed for a migration that does not run.
   */
  readonly buildContext: (host: RuntimeMigrationHost) => Context;
  readonly apply: (
    input: RuntimeMigrationApplyInput<Context, Desired>,
  ) => Promise<Result<void, RuntimeMigrationError>>;
}

interface VersionedRuntimeMigrationDefinitionArgs<Id extends string, Context> extends
  RuntimeMigrationDefinitionBase<Id, Context, { readonly version: number }> {
  readonly version: number;
}

interface ContractRuntimeMigrationDefinitionArgs<
  Id extends string,
  Context,
  Contract extends JsonValue,
> extends RuntimeMigrationDefinitionBase<Id, Context, Contract> {
  readonly buildContract: (context: Context) => Contract | Promise<Contract>;
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
export function defineVersionedRuntimeMigration<const Id extends string, Context>(
  args: VersionedRuntimeMigrationDefinitionArgs<Id, Context>,
): RuntimeMigrationDefinition<Id> {
  validateDefinitionIdentity(args.id, args.description);
  if (!Number.isSafeInteger(args.version) || args.version <= 0) {
    throw new TypeError("Runtime migration versions must be positive safe integers");
  }

  return {
    id: args.id,
    description: args.description,
    revisionKind: "version",
    prepare: async (host) => {
      const context = args.buildContext(host);
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
export function defineContractRuntimeMigration<
  const Id extends string,
  Context,
  Contract extends JsonValue,
>(
  args: ContractRuntimeMigrationDefinitionArgs<Id, Context, Contract>,
): RuntimeMigrationDefinition<Id> {
  validateDefinitionIdentity(args.id, args.description);

  return {
    id: args.id,
    description: args.description,
    revisionKind: "contract",
    prepare: async (host) => {
      try {
        const context = args.buildContext(host);
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
