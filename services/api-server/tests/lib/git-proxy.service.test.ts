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
      getExpectedBearerToken: () => params.gitProxySecret ?? "secret",
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

  function createCutoverService(gitConfiguredViaConnector: boolean) {
    const secrets: Record<string, string> = {
      git_proxy_secret: "legacy-sprite-secret",
      webhook_token: "gateway-session-token",
    };
    const service = new SessionGitProxyService({
      logger: createTestLogger(),
      env: {} as Env,
      secretRepository: {
        get: vi.fn((key: string) => secrets[key] ?? null),
        set: vi.fn(),
        delete: vi.fn(),
      } as unknown as SecretRepository,
      getServerState: () => ({
        sessionId: "abcd-session",
        userId: "user-1",
        gitConfiguredViaConnector,
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
    return service;
  }

  function fetchRefs(service: SessionGitProxyService, token: string): Promise<Response> {
    return service.handleRequest(
      createRequest("/git-proxy/abcd-session/github.com/ben/repo.git/info/refs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  }

  it("accepts the legacy sprite secret before the cutover", async () => {
    const service = createCutoverService(false);

    await expect(fetchRefs(service, "legacy-sprite-secret")).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetchRefs(service, "gateway-session-token")).resolves.toMatchObject({
      status: 401,
    });
  });

  it("accepts only the gateway-injected session token after the cutover", async () => {
    const service = createCutoverService(true);

    await expect(fetchRefs(service, "gateway-session-token")).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetchRefs(service, "legacy-sprite-secret")).resolves.toMatchObject({
      status: 401,
    });
  });
});
