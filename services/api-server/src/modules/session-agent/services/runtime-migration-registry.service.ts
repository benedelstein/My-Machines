import type { RuntimeMigrationDefinition } from
  "@/modules/session-agent/types/runtime-migration.types";
import { assertRuntimeMigrationRegistry } from "./runtime-migration-definition.service";

/** Phase 3 ships the engine dark. Production adopters begin in Phase 4. */
export const RUNTIME_MIGRATIONS = [] as const satisfies readonly RuntimeMigrationDefinition[];

assertRuntimeMigrationRegistry(RUNTIME_MIGRATIONS);
