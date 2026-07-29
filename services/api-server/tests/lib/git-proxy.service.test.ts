import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "./test-logger";
import type { ClientState } from "@repo/shared";
import { GitProxyService } from "../../src/shared/integrations/git/git-proxy.service";
import type { GitProxyTokenProvider } from "../../src/shared/integrations/git/git.providers";
import { SessionGitProxyService } from "../../src/modules/session-agent/services/session-git-proxy.service";
import type { SecretRepository } from "../../src/modules/session-agent/repositories/secret.repository";
import type { ServerState } from "../../src/modules/session-agent/repositories/server-state.repository";
import type { Env } from "../../src/shared/types";

function createService(params: {
  tokenProvider?: GitProxyTokenProvider;
  gitProxySecret?: string | null;
  repoFullName?: string | null;
  sessionId?: string | null;
  pushedBranch?: string | null;
} = {}): GitProxyService {
  return new GitProxyService({
    tokenProvider: params.tokenProvider ?? {
      getInstallationTokenForRepo: vi.fn(async () => ({
        ok: true,
        value: "installation-token",
      })),
    },
    secretProvider: {
      authenticateGitRequest: (authorization) =>
        authorization === `Bearer ${params.gitProxySecret ?? "secret"}`,
    },
    repoPolicyProvider: {
      getAllowedRepoFullName: () => params.repoFullName ?? "ben/repo",
      getSessionId: () => params.sessionId ?? "abcd-session",
      getPushedBranch: () => params.pushedBranch ?? null,
    },
    logger: createTestLogger(),
  });
}

function createRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.test${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer secret",
      ...init.headers,
    },
  });
}

function createPushBody(branch: string): string {
  return `0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 refs/heads/${branch}\0 report-status`;
}

describe("GitProxyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards allowed requests using an installation token provider", async () => {
    const fetchGitHub = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchGitHub);
    const tokenProvider: GitProxyTokenProvider = {
      getInstallationTokenForRepo: vi.fn(async () => ({
        ok: true,
        value: "provider-token",
      })),
    };
    const service = createService({ tokenProvider });

    const result = await service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/info/refs?service=git-upload-pack"),
      "/git-proxy/abcd-session/github.com/ben/repo.git/info/refs",
    );

    expect(result.response.status).toBe(200);
    expect(tokenProvider.getInstallationTokenForRepo).toHaveBeenCalledWith("ben/repo");
    expect(fetchGitHub).toHaveBeenCalledWith(
      "https://github.com/ben/repo.git/info/refs?service=git-upload-pack",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${btoa("x-access-token:provider-token")}`,
        }),
      }),
    );
  });

  it("returns provider errors without throwing", async () => {
    const service = createService({
      tokenProvider: {
        getInstallationTokenForRepo: vi.fn(async () => ({
          ok: false,
          error: {
            code: "GITHUB_API_ERROR",
            status: 503,
            message: "GitHub unavailable",
          },
        })),
      },
    });

    const result = await service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/info/refs"),
      "/git-proxy/abcd-session/github.com/ben/repo.git/info/refs",
    );

    expect(result.response.status).toBe(503);
    await expect(result.response.text()).resolves.toBe("GitHub unavailable");
  });

  it("rejects repos outside the session policy", async () => {
    const result = await createService().handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/other/repo.git/info/refs"),
      "/git-proxy/abcd-session/github.com/other/repo.git/info/refs",
    );

    expect(result.response.status).toBe(403);
    await expect(result.response.text()).resolves.toBe("repo not allowed");
  });

  it("rejects pushes to branches outside the session policy", async () => {
    const result = await createService().handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/git-receive-pack", {
        method: "POST",
        body: createPushBody("main"),
      }),
      "/git-proxy/abcd-session/github.com/ben/repo.git/git-receive-pack",
    );

    expect(result.response.status).toBe(403);
    await expect(result.response.text()).resolves.toContain("branch must start");
  });

  it.each([
    "mymachines/change-abcd",
    // Sessions created before the rename still push their locked cloude/ branch.
    "cloude/change-abcd",
  ])("allows pushes to %s", async (branch) => {
    const result = await createService().handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/git-receive-pack", {
        method: "POST",
        body: createPushBody(branch),
      }),
      "/git-proxy/abcd-session/github.com/ben/repo.git/git-receive-pack",
    );

    expect(result.response.status).toBe(200);
    expect(result.pushedBranch).toBe(branch);
  });
});

describe("SessionGitProxyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists pushed-branch side effects without storing installation tokens in DO secrets", async () => {
    const clientState = {
      repoFullName: "ben/repo",
      pushedBranch: null,
    } as ClientState;
    const serverState = {
      sessionId: "abcd-session",
      userId: "user-1",
      gitAuthMode: "legacy_secret",
    } as ServerState;
    const secretRepository = {
      get: vi.fn(() => "secret"),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as SecretRepository;
    const updatePartialState = vi.fn((partial: Partial<ClientState>) => {
      Object.assign(clientState, partial);
    });
    const updatePushedBranch = vi.fn();
    const service = new SessionGitProxyService({
      logger: createTestLogger(),
      env: {} as Env,
      secretRepository,
      getServerState: () => serverState,
      getClientState: () => clientState,
      updatePartialState,
      updatePushedBranch,
      assertSessionRepoAccess: vi.fn(async () => ({
        ok: true,
        value: {
          userId: "user-1",
          repoId: 1,
          installationId: 2,
          repoFullName: "ben/repo",
        },
      })),
      enforceSessionAccessBlocked: vi.fn(),
      githubTokenProvider: {
        getInstallationTokenForRepo: vi.fn(async () => ({
          ok: true,
          value: "github-module-token",
        })),
      },
    });

    const response = await service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/git-receive-pack", {
        method: "POST",
        body: createPushBody("cloude/change-abcd"),
      }),
    );

    expect(response.status).toBe(200);
    expect(updatePartialState).toHaveBeenCalledWith({
      pushedBranch: "cloude/change-abcd",
    });
    expect(updatePushedBranch).toHaveBeenCalledWith("cloude/change-abcd");
    expect(secretRepository.set).not.toHaveBeenCalledWith(
      "github_token",
      expect.any(String),
    );
  });
});

describe("SessionGitProxyService connector cutover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createCutoverService(gitAuthMode: ServerState["gitAuthMode"]) {
    const secrets: Record<string, string> = {
      git_proxy_secret: "legacy-sprite-secret",
      webhook_token: "gateway-session-token",
    };
    const secretRepository = {
      get: vi.fn((key: string) => secrets[key] ?? null),
      set: vi.fn((key: string, value: string) => {
        secrets[key] = value;
      }),
      delete: vi.fn((key: string) => {
        delete secrets[key];
      }),
    } as unknown as SecretRepository;
    const service = new SessionGitProxyService({
      logger: createTestLogger(),
      env: {} as Env,
      secretRepository,
      getServerState: () => ({
        sessionId: "abcd-session",
        userId: "user-1",
        gitAuthMode,
      }) as ServerState,
      getClientState: () => ({
        repoFullName: "ben/repo",
        pushedBranch: null,
      }) as ClientState,
      updatePartialState: vi.fn(),
      updatePushedBranch: vi.fn(),
      assertSessionRepoAccess: vi.fn(async () => ({
        ok: true,
        value: {
          userId: "user-1",
          repoId: 1,
          installationId: 2,
          repoFullName: "ben/repo",
        },
      })),
      enforceSessionAccessBlocked: vi.fn(),
      githubTokenProvider: {
        getInstallationTokenForRepo: vi.fn(async () => ({
          ok: true,
          value: "github-module-token",
        })),
      },
    });
    return { service, secrets, secretRepository };
  }

  function fetchRefs(service: SessionGitProxyService, token: string): Promise<Response> {
    return service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/info/refs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  }

  it("accepts the legacy sprite secret before the cutover", async () => {
    const { service } = createCutoverService("legacy_secret");

    expect(service.mintEphemeralGitToken()).toBeNull();
    await expect(fetchRefs(service, "legacy-sprite-secret")).resolves.toMatchObject({
      status: 200,
    });
    const unauthorized = await fetchRefs(service, "gateway-session-token");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate"))
      .toBe('Basic realm="my-machines-git-proxy"');
  });

  it("accepts only Basic ephemeral tokens in ephemeral-token mode", async () => {
    const { service } = createCutoverService("ephemeral_token");
    const minted = service.mintEphemeralGitToken();
    expect(minted).not.toBeNull();
    const basic = btoa(`x-ephemeral-git-token:${minted!.token}`);

    await expect(service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/info/refs", {
        headers: { Authorization: `Basic ${basic}` },
      }),
    )).resolves.toMatchObject({ status: 200 });
    await expect(fetchRefs(service, "legacy-sprite-secret")).resolves.toMatchObject({
      status: 401,
    });
    await expect(fetchRefs(service, "gateway-session-token")).resolves.toMatchObject({
      status: 401,
    });
  });

  it("rotates near expiry while accepting the previous token until expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const { service } = createCutoverService("ephemeral_token");
    const first = service.mintEphemeralGitToken()!;
    expect(service.mintEphemeralGitToken()).toEqual(first);

    vi.advanceTimersByTime(4 * 60 * 1000 + 1);
    const second = service.mintEphemeralGitToken()!;
    expect(second.token).not.toBe(first.token);
    expect(service.authenticateGitRequest(
      `Basic ${btoa(`x-ephemeral-git-token:${first.token}`)}`,
    )).toBe(true);

    vi.advanceTimersByTime(60 * 1000);
    expect(service.authenticateGitRequest(
      `Basic ${btoa(`x-ephemeral-git-token:${first.token}`)}`,
    )).toBe(false);
    expect(service.authenticateGitRequest(
      `Basic ${btoa(`x-ephemeral-git-token:${second.token}`)}`,
    )).toBe(true);
    vi.useRealTimers();
  });

  it("revokes ephemeral tokens and rejects malformed persisted JSON", () => {
    const { service, secrets } = createCutoverService("ephemeral_token");
    const minted = service.mintEphemeralGitToken()!;
    service.revokeEphemeralGitTokens();
    expect(service.authenticateGitRequest(
      `Basic ${btoa(`x-ephemeral-git-token:${minted.token}`)}`,
    )).toBe(false);

    secrets.ephemeral_git_token = "{invalid";
    expect(service.mintEphemeralGitToken()).not.toBeNull();
  });
});
