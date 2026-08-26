import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  failure,
  success,
  type IntegrationSessionRequest,
  type Repo,
} from "@repo/shared";
import {
  IntegrationSessionRequestService,
  type IntegrationSessionRequestStores,
} from "../../src/modules/integrations/services/integration-session-request.service";
import type { IntegrationSessionRequestDeps } from
  "../../src/modules/integrations/types/integrations.types";
import type { Env } from "../../src/shared/types";

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => ({ modelId: "test-model" }),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, generateText: vi.fn() };
});

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

const linkedAccount = {
  provider: "discord" as const,
  externalUserId: "discord-user-1",
  userId: "user-1",
  externalUsername: "Ben",
  expiresAt: "2026-09-01T00:00:00.000Z",
};

function makeRepo(
  id: number,
  fullName: string,
  description: string | null = null,
): Repo {
  const [owner = "acme", name = fullName] = fullName.split("/");
  return {
    id,
    name,
    fullName,
    owner,
    private: false,
    description,
    defaultBranch: "main",
  };
}

function makeRequest(prompt: string): IntegrationSessionRequest {
  return {
    externalUser: {
      provider: "discord",
      id: "discord-user-1",
      displayName: "Ben",
      username: "ben",
    },
    prompt,
  };
}

function makeHarness() {
  const accountLinks = {
    getActive: vi.fn().mockResolvedValue(linkedAccount),
    listActiveByUserId: vi.fn().mockResolvedValue([]),
    revokeByUserAndProvider: vi.fn().mockResolvedValue(undefined),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
  const linkAttempts = {
    consumeValid: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    deleteForExternalUser: vi.fn().mockResolvedValue(undefined),
  };
  const stores = { accountLinks, linkAttempts } satisfies IntegrationSessionRequestStores;

  const tokenProvider = {
    getValidGitHubAccessTokenByUserId: vi.fn().mockResolvedValue("github-token"),
  };
  const repoCandidateProvider = {
    listAccessibleRepos: vi.fn().mockResolvedValue(success([
      makeRepo(7, "acme/payments", "Payments service"),
    ])),
    getReadme: vi.fn().mockResolvedValue(null),
  };
  const environmentProvider = {
    getDefaultEnvironmentId: vi.fn().mockResolvedValue(ENVIRONMENT_ID),
  };
  const sessionCreator = {
    createSession: vi.fn().mockResolvedValue(success({
      sessionId: SESSION_ID,
      title: "Fix checkout",
      websocketToken: "websocket-token",
      websocketTokenExpiresAt: "2026-08-27T00:00:00.000Z",
    })),
  };
  const deps = {
    tokenProvider,
    repoCandidateProvider,
    environmentProvider,
    sessionCreator,
  } satisfies IntegrationSessionRequestDeps;

  const env = {
    WEB_ORIGIN: "https://app.example.test/",
    ANTHROPIC_API_KEY: "test-key",
  } as Env;
  const service = new IntegrationSessionRequestService(env, deps, stores);

  return {
    service,
    accountLinks,
    linkAttempts,
    tokenProvider,
    repoCandidateProvider,
    environmentProvider,
    sessionCreator,
  };
}

describe("IntegrationSessionRequestService", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockRejectedValue(new Error("routing unavailable"));
  });

  it("creates a link attempt when the external user is not linked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const harness = makeHarness();
    harness.accountLinks.getActive.mockResolvedValue(null);

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Fix checkout"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toMatchObject({
      ok: false,
      code: "EXTERNAL_USER_NOT_LINKED",
      linkExpiresAt: "2026-08-26T12:15:00.000Z",
    });
    expect(response.ok || response.linkUrl).toMatch(
      /^https:\/\/app\.example\.test\/discord\/link\?token=/,
    );
    expect(harness.linkAttempts.deleteForExternalUser).toHaveBeenCalledWith({
      provider: "discord",
      externalUserId: "discord-user-1",
    });
    expect(harness.linkAttempts.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: "discord",
      externalUserId: "discord-user-1",
      externalUsername: "Ben",
      expiresAt: "2026-08-26T12:15:00.000Z",
      tokenHash: expect.any(String),
    }));
  });

  it("rejects an invalid or expired link claim without creating an account link", async () => {
    const harness = makeHarness();

    const result = await harness.service.claimIntegrationLink({
      token: "expired-token",
      userId: "user-1",
    });

    expect(result).toEqual(failure({
      status: 400,
      message: "This integration link is invalid or expired. Request a new link from your integration.",
    }));
    expect(harness.accountLinks.upsert).not.toHaveBeenCalled();
  });

  it("requires GitHub authentication before listing repositories", async () => {
    const harness = makeHarness();
    harness.tokenProvider.getValidGitHubAccessTokenByUserId.mockResolvedValue(null);

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Fix acme/payments"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toEqual({
      ok: false,
      code: "GITHUB_AUTH_REQUIRED",
      message: "The linked My Machines account needs to sign in with GitHub again.",
    });
    expect(harness.repoCandidateProvider.listAccessibleRepos).not.toHaveBeenCalled();
  });

  it("reports repository provider failures without creating a session", async () => {
    const harness = makeHarness();
    harness.repoCandidateProvider.listAccessibleRepos.mockResolvedValue(failure({
      status: 503,
      message: "GitHub unavailable",
    }));

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Fix acme/payments"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toEqual({
      ok: false,
      code: "REPO_LISTING_FAILED",
      message: "I could not load the linked account's repositories. Try again shortly.",
    });
    expect(harness.sessionCreator.createSession).not.toHaveBeenCalled();
  });

  it("returns candidates when repository routing is ambiguous", async () => {
    const harness = makeHarness();
    harness.repoCandidateProvider.listAccessibleRepos.mockResolvedValue(success([
      makeRepo(1, "acme/payments-api", "Payments tools"),
      makeRepo(2, "acme/payments-web", "Payments tools"),
    ]));

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Update the payments tools"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toMatchObject({
      ok: false,
      code: "AMBIGUOUS_REPO_MATCH",
      candidates: [
        { repoId: 1, repoFullName: "acme/payments-api" },
        { repoId: 2, repoFullName: "acme/payments-web" },
      ],
    });
    expect(harness.sessionCreator.createSession).not.toHaveBeenCalled();
  });

  it("creates a session for an explicit repository and selected environment", async () => {
    const harness = makeHarness();

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Fix checkout in acme/payments"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      title: "Fix checkout",
      repoId: 7,
      repoFullName: "acme/payments",
      sessionUrl: `https://app.example.test/session/${SESSION_ID}`,
      routingReason: "Matched explicit repository name.",
    });
    expect(harness.sessionCreator.createSession).toHaveBeenCalledWith({
      userId: "user-1",
      githubAccessToken: "github-token",
      request: {
        repoId: 7,
        environmentId: ENVIRONMENT_ID,
        initialMessage: {
          content: "Discord request from Ben:\n\nFix checkout in acme/payments",
        },
      },
      source: "discord",
    });
  });

  it("returns session creation failures", async () => {
    const harness = makeHarness();
    harness.sessionCreator.createSession.mockResolvedValue(failure({
      status: 503,
      message: "No Sprite capacity",
    }));

    const response = await harness.service.createSessionFromIntegration({
      request: makeRequest("Fix checkout in acme/payments"),
      executionCtx: {} as ExecutionContext,
    });

    expect(response).toEqual({
      ok: false,
      code: "SESSION_CREATE_FAILED",
      message: "No Sprite capacity",
    });
  });
});
