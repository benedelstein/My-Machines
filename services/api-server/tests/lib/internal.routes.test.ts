import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/shared/types";

const { getSessionAgentStub } = vi.hoisted(() => ({
  getSessionAgentStub: vi.fn(),
}));

vi.mock(
  "../../src/modules/session-agent/routes/session-agent-stub",
  () => ({ getSessionAgentStub }),
);

import { createInternalRoutes } from "../../src/modules/session-agent/routes/internal.routes";

describe("Ephemeral git token mint route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the connector-injected bearer to the session DO", async () => {
    const mintEphemeralGitToken = vi.fn(() => ({
      token: "short-lived-git-token",
      expiresAt: 123456789,
    }));
    getSessionAgentStub.mockResolvedValue({ mintEphemeralGitToken });

    const response = await createInternalRoutes().request(
      "/session/session-1/git-token",
      {
        method: "POST",
        headers: { Authorization: "Bearer connector-session-token" },
      },
      {} as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "short-lived-git-token",
      expiresAt: 123456789,
    });
    expect(mintEphemeralGitToken).toHaveBeenCalledWith("connector-session-token");
  });

  it("does not accept an ephemeral git token as mint authority", async () => {
    const mintEphemeralGitToken = vi.fn(() => null);
    getSessionAgentStub.mockResolvedValue({ mintEphemeralGitToken });

    const response = await createInternalRoutes().request(
      "/session/session-1/git-token",
      {
        method: "POST",
        headers: { Authorization: "Bearer short-lived-git-token" },
      },
      {} as Env,
    );

    expect(response.status).toBe(403);
  });

  it("requires a bearer credential", async () => {
    const response = await createInternalRoutes().request(
      "/session/session-1/git-token",
      { method: "POST" },
      {} as Env,
    );

    expect(response.status).toBe(401);
    expect(getSessionAgentStub).not.toHaveBeenCalled();
  });
});
