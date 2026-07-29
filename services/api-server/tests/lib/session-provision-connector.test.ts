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

  it("configures direct Worker remotes with an exact-url credential helper", async () => {
    const serverState = createServerState();
    const { service, ensureGitProxySecret, retireGitProxySecret } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned();

    const remoteConfigCommand = getRemoteConfigCommand();
    expect(remoteConfigCommand).toContain(
      "git remote set-url origin 'https://worker.test/git-proxy/session-1/github.com/ben/repo.git'",
    );
    expect(remoteConfigCommand).toContain(
      "git remote set-url --push origin 'https://worker.test/git-proxy/session-1/github.com/ben/repo.git'",
    );
    expect(remoteConfigCommand).toContain(
      "credential.https://worker.test/git-proxy/session-1/github.com/ben/repo.git.helper",
    );
    expect(remoteConfigCommand).toContain("git config credential.useHttpPath true");
    expect(remoteConfigCommand).not.toContain("Authorization: Bearer git-proxy-secret");
    expect(ensureGitProxySecret).not.toHaveBeenCalled();
    expect(retireGitProxySecret).toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("capability");
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
      "git remote set-url origin 'https://worker.test/git-proxy/session-1/github.com/ben/repo.git'",
    );
  });

  it("fails closed before retiring legacy auth when capability setup fails", async () => {
    const serverState = createServerState();
    const { service, retireGitProxySecret } = createService(
      serverState,
      createClientState(),
    );
    const defaultExec = mockState.execWs.getMockImplementation()!;
    mockState.execWs.mockImplementation(async (command: string, options: unknown) => {
      if (command.includes("credential.useHttpPath")) {
        return { stdout: "", stderr: "git config failed", exitCode: 1 };
      }
      return defaultExec(command, options);
    });

    await expect(service.ensureProvisioned()).rejects.toThrow(
      "Git capability setup failed (exit 1): git config failed",
    );
    expect(retireGitProxySecret).not.toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("legacy_secret");
  });

  it("keeps legacy bearer configuration for pre-connector sessions", async () => {
    const serverState = createServerState();
    const { service, ensureGitProxySecret } = createService(
      serverState,
      createClientState({ includeSessionConnector: false }),
    );

    await service.ensureProvisioned();

    const command = getRemoteConfigCommand();
    expect(command).toContain("Authorization: Bearer git-proxy-secret");
    expect(ensureGitProxySecret).toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("legacy_secret");
  });
});
