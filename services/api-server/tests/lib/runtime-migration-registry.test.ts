import { describe, expect, it } from "vitest";
import { RUNTIME_MIGRATIONS } from
  "../../src/modules/session-agent/services/runtime-migration/runtime-migration-registry.service";

describe("Phase 4 runtime migration registry", () => {
  it("contains only the startup toolchain adopter", () => {
    expect(RUNTIME_MIGRATIONS.map(({ id, revisionKind }) => ({ id, revisionKind }))).toEqual([{
      id: "sprite.startup-toolchain",
      revisionKind: "contract",
    }]);
    expect(RUNTIME_MIGRATIONS.map((definition) => definition.id)).not.toContain(
      "session.connector-resource",
    );
    expect(RUNTIME_MIGRATIONS.map((definition) => definition.id)).not.toContain(
      "sprite.git-ephemeral-token-cutover",
    );
    expect(RUNTIME_MIGRATIONS.map((definition) => definition.id)).not.toContain(
      "sprite.network-policy",
    );
    expect(RUNTIME_MIGRATIONS.map((definition) => definition.id)).not.toContain(
      "agent.reusable-process",
    );
  });
});
