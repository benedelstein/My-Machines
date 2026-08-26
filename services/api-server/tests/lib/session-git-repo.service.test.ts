import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { SessionGitRepoService } from
  "../../src/modules/session-agent/services/session-git-repo.service";
import {
  createClientState,
  createServerState,
} from "./session-provision-test-support";
import { createTestLogger } from "./test-logger";

describe("SessionGitRepoService", () => {
  const execWs = vi.fn();
  const writeFile = vi.fn();
  const getReadOnlyTokenForRepo = vi.fn();
  const retireGitProxySecret = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    execWs.mockImplementation(async (command: string) => {
      if (command.startsWith("test -d")) {
        return { stdout: "empty", stderr: "", exitCode: 0 };
      }
      if (command.includes("git rev-parse")) {
        return { stdout: "main", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    writeFile.mockResolvedValue(undefined);
    getReadOnlyTokenForRepo.mockResolvedValue({ ok: true, value: "clone-token" });
  });

  function createHarness(args: {
    repoCloned?: boolean;
    spriteName?: string | null;
  } = {}) {
    const serverState = createServerState({
      spriteName: args.spriteName === undefined ? "sprite-1" : args.spriteName,
      repoCloned: args.repoCloned ?? false,
    });
    const clientState = createClientState();
    const updateRepoCloned = vi.fn((repoCloned: boolean) => {
      serverState.repoCloned = repoCloned;
    });
    const updateGitAuthMode = vi.fn((gitAuthMode: typeof serverState.gitAuthMode) => {
      serverState.gitAuthMode = gitAuthMode;
    });
    const updatePartialState = vi.fn();
    const sprite = { execWs, writeFile } as unknown as WorkersSpriteClient;
    const service = new SessionGitRepoService({
      logger: createTestLogger(),
      env: { WORKER_URL: "https://worker.test" },
      createSpriteClient: vi.fn(() => sprite),
      getServerState: () => serverState,
      getClientState: () => clientState,
      updateRepoCloned,
      updateGitAuthMode,
      updatePartialState,
      retireGitProxySecret,
      getSessionConnectorGatewayBase: () => "https://gateway.test/connector-1",
      githubTokenProvider: { getReadOnlyTokenForRepo },
    });
    return {
      service,
      serverState,
      updatePartialState,
      updateRepoCloned,
      updateGitAuthMode,
    };
  }

  it("clones once and records the repository checkpoint", async () => {
    const { service, serverState, updateRepoCloned } = createHarness();

    await service.ensureCloned("sprite-1");
    await service.ensureCloned("sprite-1");

    expect(getReadOnlyTokenForRepo).toHaveBeenCalledOnce();
    expect(execWs.mock.calls.filter(([command]) => String(command).includes("git -c")))
      .toHaveLength(1);
    expect(updateRepoCloned).toHaveBeenCalledWith(true);
    expect(serverState.repoCloned).toBe(true);
  });

  it("adopts an existing clone and reconciles its actual base branch", async () => {
    execWs.mockImplementation(async (command: string) => {
      if (command.startsWith("test -d")) {
        return { stdout: "exists", stderr: "", exitCode: 0 };
      }
      if (command.includes("git rev-parse")) {
        return { stdout: "release\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { service, serverState, updatePartialState } = createHarness();

    await service.ensureCloned("sprite-1");

    expect(getReadOnlyTokenForRepo).not.toHaveBeenCalled();
    expect(updatePartialState).toHaveBeenCalledWith({ baseBranch: "release" });
    expect(serverState.repoCloned).toBe(true);
  });

  it("does not record the clone checkpoint when cloning fails", async () => {
    execWs.mockImplementation(async (command: string) => {
      if (command.startsWith("test -d")) {
        return { stdout: "empty", stderr: "", exitCode: 0 };
      }
      if (command.includes("git -c")) {
        return { stdout: "", stderr: "denied", exitCode: 128 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { service, serverState } = createHarness();

    await expect(service.ensureCloned("sprite-1"))
      .rejects.toThrow("Clone failed (exit 128): denied");
    expect(serverState.repoCloned).toBe(false);
  });

  it("requires a completed clone before reconciling ephemeral Git auth", async () => {
    const { service } = createHarness({ repoCloned: false });

    await expect(service.reconcileEphemeralTokenCutover())
      .rejects.toThrow("Repository must be cloned before Git cutover");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("reconciles ephemeral Git auth before retiring the legacy secret", async () => {
    const { service, serverState, updateGitAuthMode } = createHarness({ repoCloned: true });

    await service.reconcileEphemeralTokenCutover();

    expect(writeFile).toHaveBeenCalledWith(
      "/home/sprite/.local/bin/mm-git-credential-session-1",
      expect.stringContaining("x-ephemeral-git-token"),
      { mode: "0700" },
    );
    expect(retireGitProxySecret).toHaveBeenCalledOnce();
    expect(updateGitAuthMode).toHaveBeenCalledWith("ephemeral_token");
    expect(serverState.gitAuthMode).toBe("ephemeral_token");
  });

  it("keeps legacy auth when ephemeral Git verification fails", async () => {
    execWs.mockResolvedValue({ stdout: "", stderr: "git config failed", exitCode: 1 });
    const { service, serverState } = createHarness({ repoCloned: true });

    await expect(service.reconcileEphemeralTokenCutover())
      .rejects.toThrow("Ephemeral git token setup failed (exit 1): git config failed");
    expect(retireGitProxySecret).not.toHaveBeenCalled();
    expect(serverState.gitAuthMode).toBe("legacy_secret");
  });
});
