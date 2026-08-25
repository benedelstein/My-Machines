import type { RuntimeMigrationDefinition } from
  "@/modules/session-agent/types/runtime-migration.types";
import { assertRuntimeMigrationRegistry } from "./runtime-migration-definition.service";
import { startupToolchainRuntimeMigration } from
  "./startup-toolchain-runtime-migration.service";
import { sessionSpriteLabelsRuntimeMigration } from
  "./session-sprite-labels-runtime-migration.service";
import { sessionConnectorRuntimeMigration } from
  "./session-connector-runtime-migration.service";
import { gitEphemeralTokenRuntimeMigration } from
  "./git-ephemeral-token-runtime-migration.service";
import { networkPolicyRuntimeMigration } from
  "./network-policy-runtime-migration.service";

export const RUNTIME_MIGRATIONS = [
  startupToolchainRuntimeMigration,
  sessionSpriteLabelsRuntimeMigration,
  sessionConnectorRuntimeMigration,
  gitEphemeralTokenRuntimeMigration,
  networkPolicyRuntimeMigration,
] as const satisfies readonly RuntimeMigrationDefinition[];

export type RuntimeMigrationId = (typeof RUNTIME_MIGRATIONS)[number]["id"];

assertRuntimeMigrationRegistry(RUNTIME_MIGRATIONS);
