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

describe("Git capability mint route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the connector-injected bearer to the session DO", async () => {
    const mintGitCapability = vi.fn(() => ({
      token: "short-lived-capability",
      expiresAt: 123456789,
    }));
    getSessionAgentStub.mockResolvedValue({ mintGitCapability });

    const response = await createInternalRoutes().request(
      "/session/session-1/capabilities/git",
      {
        method: "POST",
        headers: { Authorization: "Bearer connector-session-token" },
      },
      {} as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "short-lived-capability",
      expiresAt: 123456789,
    });
    expect(mintGitCapability).toHaveBeenCalledWith("connector-session-token");
  });

  it("does not accept a Git capability as mint authority", async () => {
    const mintGitCapability = vi.fn(() => null);
    getSessionAgentStub.mockResolvedValue({ mintGitCapability });

    const response = await createInternalRoutes().request(
      "/session/session-1/capabilities/git",
      {
        method: "POST",
        headers: { Authorization: "Bearer short-lived-capability" },
      },
      {} as Env,
    );

    expect(response.status).toBe(403);
  });

  it("requires a bearer credential", async () => {
    const response = await createInternalRoutes().request(
      "/session/session-1/capabilities/git",
      { method: "POST" },
      {} as Env,
    );

    expect(response.status).toBe(401);
    expect(getSessionAgentStub).not.toHaveBeenCalled();
  });
});
