import type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";
import type {
  RuntimeMigrationDefinition,
  RuntimeMigrationDependencies,
} from "@/modules/session-agent/types/runtime-migration.types";
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
 * Migrations receive the shared dependencies, never a pre-built context —
 * each builds its own, so no adopter can smuggle an undeclared field through.
 */
export type MigrationsPrepareFromDependencies = Assert<Equal<
  Parameters<RuntimeMigrationDefinition["prepare"]>[0],
  RuntimeMigrationDependencies
>>;
