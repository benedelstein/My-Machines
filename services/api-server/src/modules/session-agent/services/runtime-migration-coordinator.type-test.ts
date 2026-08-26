import type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";
import type { RuntimeMigrationCoordinator } from "./runtime-migration-coordinator.service";

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
