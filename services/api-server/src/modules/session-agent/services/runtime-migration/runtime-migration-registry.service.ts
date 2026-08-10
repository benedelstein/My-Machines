import type { RuntimeMigrationDefinition } from
  "@/modules/session-agent/types/runtime-migration.types";
import { assertRuntimeMigrationRegistry } from "./runtime-migration-definition.service";
import { startupToolchainRuntimeMigration } from
  "./startup-toolchain-runtime-migration.service";
import { sessionConnectorRuntimeMigration } from
  "./session-connector-runtime-migration.service";
import { gitEphemeralTokenRuntimeMigration } from
  "./git-ephemeral-token-runtime-migration.service";
import { networkPolicyRuntimeMigration } from
  "./network-policy-runtime-migration.service";

/** Phase 5 activates the ordered session-networking cohort; process stays disabled. */
export const RUNTIME_MIGRATIONS = [
  startupToolchainRuntimeMigration,
  sessionConnectorRuntimeMigration,
  gitEphemeralTokenRuntimeMigration,
  networkPolicyRuntimeMigration,
] as const satisfies readonly RuntimeMigrationDefinition[];

export type RuntimeMigrationId = (typeof RUNTIME_MIGRATIONS)[number]["id"];

assertRuntimeMigrationRegistry(RUNTIME_MIGRATIONS);
