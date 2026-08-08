import type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";
import type { ServerState } from
  "@/modules/session-agent/types/server-state.types";
import type {
  RuntimeMigrationDefinition,
  RuntimeMigrationHost,
} from "@/modules/session-agent/types/runtime-migration.types";
import type { RuntimeMigrationServerState } from
  "@/modules/session-agent/types/runtime-migration-host.types";
import type { RuntimeMigrationCoordinator } from "./runtime-migration-coordinator.service";
import type { RuntimeMigrationId } from "./runtime-migration-registry.service";
import type { SessionProvisionService } from "../session-provision.service";

type Assert<Condition extends true> = Condition;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

export type EnsureMigrationsRequiresLease = Assert<Equal<
  Parameters<RuntimeMigrationCoordinator["ensureMigrations"]>[1],
  RuntimeBoundaryLease
>>;

export type EnsureMigrationRequiresLease = Assert<Equal<
  Parameters<RuntimeMigrationCoordinator["ensureMigration"]>[2],
  RuntimeBoundaryLease
>>;

export type EnsureProvisionedRequiresLease = Assert<Equal<
  Parameters<SessionProvisionService["ensureProvisioned"]>[0],
  RuntimeBoundaryLease
>>;

export type RuntimeMigrationIdRemainsClosed = Assert<Equal<
  string extends RuntimeMigrationId ? true : false,
  false
>>;

/** The registry-scoped coordinator only accepts registered migration IDs. */
export type EnsureMigrationRejectsUnregisteredIds = Assert<Equal<
  Parameters<RuntimeMigrationCoordinator<RuntimeMigrationId>["ensureMigration"]>[0],
  RuntimeMigrationId
>>;

/**
 * Migrations receive the host, never a pre-built context — each definition
 * builds its own, so no adopter can smuggle an undeclared field through.
 */
export type MigrationsPrepareFromHost = Assert<Equal<
  Parameters<RuntimeMigrationDefinition["prepare"]>[0],
  RuntimeMigrationHost
>>;

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/**
 * `RuntimeMigrationServerState` is hand-written rather than
 * `Pick<ServerState, ...>` because `types/` may not import `repositories/`.
 * Asserted here instead, where both layers are reachable: renaming a field,
 * changing its type, or dropping it from `ServerState` fails this build.
 */
export type MigrationServerStateMatchesServerState = Assert<Equal<
  Pick<ServerState, keyof RuntimeMigrationServerState>,
  Mutable<RuntimeMigrationServerState>
>>;
