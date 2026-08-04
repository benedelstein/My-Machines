import type { RuntimeMigrationDefinition } from
  "@/modules/session-agent/types/runtime-migration.types";
import { assertRuntimeMigrationRegistry } from "./runtime-migration-definition.service";
import { startupToolchainRuntimeMigration } from
  "./startup-toolchain-runtime-migration.service";

/** Phase 4 activates only the startup-toolchain adopter. */
export const RUNTIME_MIGRATIONS = [
  startupToolchainRuntimeMigration,
] as const satisfies readonly RuntimeMigrationDefinition[];

export type RuntimeMigrationId = (typeof RUNTIME_MIGRATIONS)[number]["id"];

assertRuntimeMigrationRegistry(RUNTIME_MIGRATIONS);
