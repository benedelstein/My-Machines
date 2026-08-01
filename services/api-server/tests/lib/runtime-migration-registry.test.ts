import { describe, expect, it } from "vitest";
import { RUNTIME_MIGRATIONS } from
  "../../src/modules/session-agent/services/runtime-migration-registry.service";

describe("Phase 3 runtime migration registry", () => {
  it("is exactly empty so no production adopter is reachable", () => {
    expect(RUNTIME_MIGRATIONS).toEqual([]);
    expect(RUNTIME_MIGRATIONS).toHaveLength(0);
  });
});
