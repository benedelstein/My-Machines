import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientState,
  createEnvironmentSnapshot,
  createServerState,
  createService,
  createSetupReporter,
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

  it("mints the connector between toolchain and clone when enabled", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState({ includeSessionConnector: true }),
      { SESSION_CONNECTORS_ENABLED: "1" },
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

  it("skips the connector task when minting is disabled", async () => {
    const serverState = createServerState();
    const setupReporter = createSetupReporter();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState({ includeSessionConnector: true }),
      {},
      createEnvironmentSnapshot(),
      setupReporter,
    );

    await service.ensureProvisioned();

    expect(ensureSessionConnector).not.toHaveBeenCalled();
    expect(setupReporter.skipTask).toHaveBeenCalledWith("session_connector");
    expect(mockState.events).toContain("cloneRepo");
  });

  it("configures git remotes through the connector gateway under the git cutover", async () => {
    const serverState = createServerState();
    const { service, ensureGitProxySecret } = createService(
      serverState,
      createClientState({ includeSessionConnector: true }),
      { SESSION_CONNECTOR_GIT_CUTOVER: "1" },
    );

    await service.ensureProvisioned();

    const gatewayRemote =
      "https://api.sprites.test/v1/gateway/custom_api/conn-1/git-proxy/session-1/github.com/ben/repo.git";
    const remoteConfigCommand = getRemoteConfigCommand();
    expect(remoteConfigCommand).toContain(`git remote set-url origin ${gatewayRemote}`);
    expect(remoteConfigCommand).toContain(`git remote set-url --push origin ${gatewayRemote}`);
    expect(remoteConfigCommand).not.toContain("extraHeader\" \"Authorization");
    expect(ensureGitProxySecret).not.toHaveBeenCalled();
    expect(serverState.gitConfiguredViaConnector).toBe(true);
  });

  it("fails the repository task when the git cutover has no connector gateway", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState({ includeSessionConnector: false }),
      { SESSION_CONNECTOR_GIT_CUTOVER: "1" },
    );
    ensureSessionConnector.mockImplementation(async () => {});

    await expect(service.ensureProvisioned()).rejects.toThrow(
      "Session connector gateway base is missing",
    );
  });
});
