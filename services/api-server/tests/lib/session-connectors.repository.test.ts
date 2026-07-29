import { describe, expect, it, vi } from "vitest";
import { SessionConnectorsRepository } from "../../src/modules/session-agent/repositories/session-connectors.repository";

const baseRow = {
  session_id: "session-1",
  gateway_connection_id: "connection-1",
  connector_name: "session-session-1",
  status: "active",
  created_at: "2026-07-29T00:00:00.000Z",
  updated_at: "2026-07-29T00:00:00.000Z",
};

function databaseReturning(policySummaryJson: string): D1Database {
  const first = vi.fn(async () => ({
    ...baseRow,
    policy_summary_json: policySummaryJson,
  }));
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare } as unknown as D1Database;
}

describe("SessionConnectorsRepository", () => {
  it("parses a valid access policy at the D1 boundary", async () => {
    const repository = new SessionConnectorsRepository(databaseReturning(JSON.stringify({
      allowAll: false,
      spriteLabels: ["session:session-1"],
      allowedEndpoints: ["/health"],
    })));

    await expect(repository.get("session-1")).resolves.toMatchObject({
      policySummary: {
        allowAll: false,
        spriteLabels: ["session:session-1"],
        allowedEndpoints: ["/health"],
      },
    });
  });

  it.each([
    "{invalid",
    JSON.stringify([]),
    JSON.stringify({ allowAll: "false", spriteLabels: [] }),
  ])("degrades an invalid access policy to null", async (policySummaryJson) => {
    const repository = new SessionConnectorsRepository(
      databaseReturning(policySummaryJson),
    );

    await expect(repository.get("session-1")).resolves.toMatchObject({
      policySummary: null,
    });
  });
});
