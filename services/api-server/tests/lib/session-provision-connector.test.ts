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

  it("configures git remotes through the connector gateway", async () => {
    const serverState = createServerState();
    const { service } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned();

    const gatewayRemote =
      "https://api.sprites.test/v1/gateway/custom_api/conn-1/git-proxy/session-1/github.com/ben/repo.git";
    const remoteConfigCommand = getRemoteConfigCommand();
    expect(remoteConfigCommand).toContain(`git remote set-url origin ${gatewayRemote}`);
    expect(remoteConfigCommand).toContain(`git remote set-url --push origin ${gatewayRemote}`);
    expect(remoteConfigCommand).not.toContain("extraHeader\" \"Authorization");
    expect(serverState.gitConfiguredViaConnector).toBe(true);
  });

  it("fails the repository task when no connector gateway exists", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState({ includeSessionConnector: false }),
    );
    ensureSessionConnector.mockImplementation(async () => {});

    await expect(service.ensureProvisioned()).rejects.toThrow(
      "Session connector gateway base is missing",
    );
  });
});
