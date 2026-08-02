import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentSdkStateRepository } from "../../src/modules/session-agent/repositories/agent-sdk-state.repository";
import { LatestPlanRepository } from "../../src/modules/session-agent/repositories/latest-plan.repository";
import { MessageRepository } from "../../src/modules/session-agent/repositories/message.repository";
import { PendingChunkRepository } from "../../src/modules/session-agent/repositories/pending-chunk.repository";
import { RuntimeMigrationRepository } from
  "../../src/modules/session-agent/repositories/runtime-migration.repository";
import { SecretRepository } from "../../src/modules/session-agent/repositories/secret.repository";
import { ServerStateRepository } from "../../src/modules/session-agent/repositories/server-state.repository";
import { SessionEnvironmentSnapshotRepository } from "../../src/modules/session-agent/repositories/session-environment-snapshot.repository";
import { SetupOutputRepository } from "../../src/modules/session-agent/repositories/setup-output.repository";
import type { Repository, SqlFn } from "../../src/modules/session-agent/repositories/repository.types";

/**
 * Repository migration arrays are append-only persisted history: the array
 * index is the version recorded in `schema_migrations`, so removing, editing,
 * or reordering an existing entry silently corrupts every deployed Durable
 * Object's migration bookkeeping.
 *
 * This test pins a fingerprint of each existing migration step. When you APPEND
 * a migration, add its fingerprint to the END of the matching list (run the
 * test to see the new value). If this test fails without an append, you have
 * modified, removed, or reordered persisted history — revert and append a new
 * migration instead.
 */

const noopSql: SqlFn = () => [];

function fingerprint(step: (sql: SqlFn) => void): string {
  const normalizedSource = step.toString().replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalizedSource).digest("hex").slice(0, 16);
}

const REPOSITORIES: Repository[] = [
  new MessageRepository(noopSql),
  new SecretRepository(noopSql),
  new LatestPlanRepository(noopSql),
  new ServerStateRepository(noopSql),
  new SessionEnvironmentSnapshotRepository(noopSql),
  new PendingChunkRepository(noopSql),
  new RuntimeMigrationRepository(noopSql),
  new SetupOutputRepository(noopSql),
  new AgentSdkStateRepository(),
];

const EXPECTED_MIGRATION_FINGERPRINTS: Record<string, string[]> = {
  // Empty by design: live sessions are already at the current client-state
  // shape. This is the registration point for future surgical migrations.
  agent_sdk_client_state: [],
  latest_session_plans: ["fa7af98c4e64afe5"],
  messages: ["a56628f52e8be595"],
  pending_message_chunks: ["6249ba5ddde259ae", "318de310a498486b"],
  secrets: ["8a940642e3e822ef"],
  session_runtime_migrations: ["19a5184ee1258acf"],
  server_state: ["851a227f32ff6fde"],
  session_environment_snapshot: ["9fdbf834b964c745"],
  setup_script_output_chunks: ["9c52bd639e49ccb8"],
};

describe("repository migration arrays", () => {
  it("declares a unique stable name per repository", () => {
    const names = REPOSITORIES.map((repo) => repo.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only ever appends migrations (array index is persisted history)", () => {
    const actual = Object.fromEntries(
      REPOSITORIES.map((repo) => [repo.name, repo.migrations.map(fingerprint)]),
    );
    expect(actual).toEqual(EXPECTED_MIGRATION_FINGERPRINTS);
  });
});
