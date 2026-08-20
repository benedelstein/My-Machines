import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../src/shared/utils/git-branch";
import {
  createClientState,
  createEnvironmentSnapshot,
  createServerState,
  createService,
  getRemoteConfigCommand,
  mockState,
  resetProvisionMocks,
  TEST_RUNTIME_BOUNDARY_LEASE,
} from "./session-provision-test-support";

vi.mock("@repo/sprites-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocks = await import("./session-provision-mocks");
  return mocks.mockSpriteClientModule(actual);
});

vi.mock("@/modules/session-agent/services/runtime-migration/startup-toolchain/startup-toolchain.service", async () => {
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

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

    expect(spriteLifecycleClient.createSprite).toHaveBeenCalledWith({
      name: "session-1",
      labels: ["session:session-1", "env:environment-1"],
    });
  });

  it("hands the successful create response to the execution-local consumer", async () => {
    const { service, discardFreshSpriteSnapshot, onSpriteCreated } = createService(
      createServerState(),
      createClientState(),
    );

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

    expect(onSpriteCreated).toHaveBeenCalledWith({
      name: "sprite-1",
      status: "running",
      labels: ["session:session-1"],
    });
    expect(discardFreshSpriteSnapshot).toHaveBeenCalledOnce();
    expect(discardFreshSpriteSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(onSpriteCreated.mock.invocationCallOrder[0]!);
  });

  it("mints the connector between toolchain and clone", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

    expect(mockState.events).toEqual([
      "createSprite",
      "setNetworkPolicy",
      "startupToolchain",
      "mintConnector",
      "cloneCheck",
      "cloneRepo",
      "setNetworkPolicy",
    ]);
    expect(ensureSessionConnector).toHaveBeenCalledOnce();
  });

  it("configures direct Worker remotes with an exact-url credential helper", async () => {
    const serverState = createServerState();
    const { service, retireGitProxySecret } = createService(
      serverState,
      createClientState(),
    );

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

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
    const expectedHelper = `!${[
      "/home/sprite/.local/bin/mm-git-credential-session-1",
      "https://worker.test/git-proxy/session-1/github.com/ben/repo.git",
      "https://gateway.test/conn-1/internal/session/session-1/git-token",
    ].map(shellQuote).join(" ")}`;
    expect(remoteConfigCommand).toContain(
      `git config --add ${
        shellQuote("credential.https://worker.test/git-proxy/session-1/github.com/ben/repo.git.helper")
      } ${shellQuote(expectedHelper)}`,
    );
    expect(mockState.writeFile).toHaveBeenCalledWith(
      "/home/sprite/.local/bin/mm-git-credential-session-1",
      expect.stringContaining("x-ephemeral-git-token"),
      { mode: "0700" },
    );
    expect(remoteConfigCommand).toContain("git config credential.useHttpPath true");
    expect(remoteConfigCommand).toContain(
      "git config 'http.https://worker.test/git-proxy/session-1/.proactiveAuth' basic",
    );
    expect(remoteConfigCommand).not.toContain("Authorization: Bearer git-proxy-secret");
    expect(retireGitProxySecret).toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("ephemeral_token");
  });

  it("uses the worker proxy for fetch in locked network mode", async () => {
    const serverState = createServerState();
    const { service } = createService(
      serverState,
      createClientState(),
      {},
      createEnvironmentSnapshot({ network: { mode: "locked" } }),
    );

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

    expect(getRemoteConfigCommand()).toContain(
      "git remote set-url origin 'https://worker.test/git-proxy/session-1/github.com/ben/repo.git'",
    );
  });

  it("fails closed before retiring legacy auth when ephemeral git token setup fails", async () => {
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

    await expect(service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE)).rejects.toThrow(
      "Ephemeral git token setup failed (exit 1): git config failed",
    );
    expect(retireGitProxySecret).not.toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("legacy_secret");
  });

  it("reconciles the connector inside an immutable historical repository task", async () => {
    const serverState = createServerState();
    const { service, ensureSessionConnector, retireGitProxySecret } = createService(
      serverState,
      createClientState({ includeSessionConnector: false }),
    );

    await service.ensureProvisioned(TEST_RUNTIME_BOUNDARY_LEASE);

    const remoteConfigCall = mockState.execWs.mock.calls.find(([command]) =>
      String(command).includes("git remote set-url origin"));
    expect(ensureSessionConnector).toHaveBeenCalledOnce();
    expect(remoteConfigCall).toBeDefined();
    expect(retireGitProxySecret).toHaveBeenCalledOnce();
    expect(serverState.gitAuthMode).toBe("ephemeral_token");
  });
});
