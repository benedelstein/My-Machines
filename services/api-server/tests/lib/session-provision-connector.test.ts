import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientState,
  createEnvironmentSnapshot,
  createServerState,
  createService,
  getRemoteConfigCommand,
  mockState,
  resetProvisionMocks,
} from "./session-provision-test-support";

vi.mock("@repo/sprites-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocks = await import("./session-provision-mocks");
  return mocks.mockSpriteClientModule(actual);
});

vi.mock("@/shared/integrations/sprite-startup-toolchain", async () => {
  const mocks = await import("./session-provision-mocks");
  return { ensureSpriteStartupToolchain: mocks.mockState.ensureSpriteStartupToolchain };
});

describe("SessionProvisionService session connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProvisionMocks();
  });

  it("creates the sprite with session and environment labels", async () => {
    const serverState = createServerState();
    const { service, spriteLifecycleClient } = createService(
      serverState,
      createClientState(),
      {},
      createEnvironmentSnapshot({ sourceEnvironmentId: "environment-1" }),
    );

    await service.ensureProvisioned();

    expect(spriteLifecycleClient.createSprite).toHaveBeenCalledWith({
      name: "session-1",
      labels: ["session:session-1", "env:environment-1"],
    });
  });

  it("mints the connector between toolchain and clone", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned();

    expect(mockState.events).toEqual([
      "createSprite",
      "setNetworkPolicy",
      "startupToolchain",
      "mintConnector",
      "cloneCheck",
      "cloneRepo",
      "setNetworkPolicy",
    ]);
    expect(ensureSessionConnector).toHaveBeenCalledWith("sprite-1");
  });

  it("keeps post-clone git on the legacy worker proxy while the gateway rejects git", async () => {
    // The Sprites gateway 406s git smart-HTTP Accept headers (2026-07-28), so
    // git remotes stay on the worker-proxy bearer path until Fly fixes it.
    const serverState = createServerState();
    const { service, ensureGitProxySecret } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned();

    const remoteConfigCommand = getRemoteConfigCommand();
    expect(remoteConfigCommand).toContain(
      "git remote set-url origin https://github.com/ben/repo.git",
    );
    expect(remoteConfigCommand).toContain(
      "git remote set-url --push origin https://worker.test/git-proxy/session-1/github.com/ben/repo.git",
    );
    expect(remoteConfigCommand).toContain(
      "git config --add \"http.https://worker.test/git-proxy/session-1/.extraHeader\" \"Authorization: Bearer git-proxy-secret\"",
    );
    expect(ensureGitProxySecret).toHaveBeenCalled();
    expect(serverState.gitConfiguredViaConnector).toBe(false);
  });

  it("uses the worker proxy for fetch in locked network mode", async () => {
    const serverState = createServerState();
    const { service } = createService(
      serverState,
      createClientState(),
      {},
      createEnvironmentSnapshot({ network: { mode: "locked" } }),
    );

    await service.ensureProvisioned();

    expect(getRemoteConfigCommand()).toContain(
      "git remote set-url origin https://worker.test/git-proxy/session-1/github.com/ben/repo.git",
    );
  });
});
