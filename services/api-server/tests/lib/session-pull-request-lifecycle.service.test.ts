import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SETTINGS, failure, success, type ClientState, type Logger } from "@repo/shared";
import { SessionPullRequestLifecycleService } from "../../src/runtime/session-pull-request-lifecycle.service";
import {
  createPullRequestForSessionContext,
  type SessionPullRequestGitHubProvider,
} from "../../src/modules/sessions/services/session-pull-request.service";
import type {
  GitHubAppResult,
  GitHubCompareData,
  PullRequestData,
} from "../../src/shared/types/github";
import type { MessageRepository } from "../../src/modules/session-agent/repositories/message.repository";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import type { SessionSummaryService } from "../../src/modules/session-agent/services/session-summary.service";

function createLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope() {
      return this;
    },
  };
}

function createClientState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    repoFullName: "ben/repo",
    status: "ready",
    sessionSetupRun: null,
    agentSettings: { ...DEFAULT_AGENT_SETTINGS },
    pullRequest: null,
    pushedBranch: "cloude/change-abcd",
    baseBranch: "main",
    todos: null,
    plan: null,
    pendingUserMessage: null,
    activeTurn: null,
    editorUrl: null,
    providerConnection: null,
    agentMode: "edit",
    lastError: null,
    createdAt: new Date("2026-06-05T00:00:00.000Z"),
    ...overrides,
  };
}

function createHarness(overrides: {
  clientState?: Partial<ClientState>;
  createPullRequestResult?: GitHubAppResult<PullRequestData>;
} = {}) {
  const clientState = createClientState(overrides.clientState);
  const serverState = { sessionId: "session-1" } as ServerState;
  const github: SessionPullRequestGitHubProvider = {
    compareBranches: vi.fn<SessionPullRequestGitHubProvider["compareBranches"]>()
      .mockResolvedValue(failure({
        code: "GITHUB_API_ERROR",
        message: "Compare failed",
      }) as GitHubAppResult<GitHubCompareData>),
    createPullRequest: vi.fn<SessionPullRequestGitHubProvider["createPullRequest"]>()
      .mockResolvedValue(overrides.createPullRequestResult ?? success({
        number: 12,
        url: "https://github.com/ben/repo/pull/12",
        state: "open",
        merged: false,
      }) as GitHubAppResult<PullRequestData>),
    getPullRequest: vi.fn<SessionPullRequestGitHubProvider["getPullRequest"]>(),
  };
  const messageRepository = {
    getAllBySession: vi.fn(() => []),
  } as unknown as MessageRepository;
  const sessionSummaryService = {
    persistPullRequest: vi.fn().mockResolvedValue(undefined),
    persistPullRequestState: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionSummaryService;
  const setPullRequestClientState = vi.fn((pullRequest: ClientState["pullRequest"]) => {
    clientState.pullRequest = pullRequest;
  });
  const service = new SessionPullRequestLifecycleService({
    logger: createLogger(),
    github,
    anthropicApiKey: "test-key",
    webOrigin: "https://www.mymachines.dev/",
    createPullRequest: createPullRequestForSessionContext,
    messageRepository,
    sessionSummaryService,
    getServerState: () => serverState,
    getClientState: () => clientState,
    setPullRequestClientState,
  });

  return {
    clientState,
    github,
    service,
    sessionSummaryService,
    setPullRequestClientState,
  };
}

describe("SessionPullRequestLifecycleService", () => {
  it("sets creating, creates the pull request, then persists created state", async () => {
    const { github, service, sessionSummaryService, setPullRequestClientState } = createHarness();

    await expect(service.handleCreatePullRequest()).resolves.toEqual({
      ok: true,
      value: {
        number: 12,
        url: "https://github.com/ben/repo/pull/12",
        state: "open",
      },
    });

    expect(setPullRequestClientState.mock.calls.map(([pullRequest]) => pullRequest?.status))
      .toEqual(["creating", "created"]);
    expect(github.createPullRequest).toHaveBeenCalledWith("ben/repo", {
      title: "Change",
      body: "My Machines session: https://www.mymachines.dev/session/session-1",
      head: "cloude/change-abcd",
      base: "main",
    });
    expect(sessionSummaryService.persistPullRequest).toHaveBeenCalledWith({
      number: 12,
      url: "https://github.com/ben/repo/pull/12",
      state: "open",
    });
  });

  it("sets failed state when GitHub pull request creation fails", async () => {
    const { service, sessionSummaryService, setPullRequestClientState } = createHarness({
      createPullRequestResult: failure({
        code: "GITHUB_API_ERROR",
        message: "Failed to create pull request for ben/repo.",
        details: "GitHub returned 422: Validation Failed: base invalid",
      }),
    });

    await expect(service.handleCreatePullRequest()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "PULL_REQUEST_CREATE_FAILED",
        details: "GitHub returned 422: Validation Failed: base invalid (base: main, head: cloude/change-abcd)",
      },
    });

    expect(setPullRequestClientState.mock.calls.map(([pullRequest]) => pullRequest?.status))
      .toEqual(["creating", "failed"]);
    expect(setPullRequestClientState.mock.calls[1]![0]).toMatchObject({
      status: "failed",
      error: "Failed to create pull request",
      details: "GitHub returned 422: Validation Failed: base invalid (base: main, head: cloude/change-abcd)",
    });
    expect(sessionSummaryService.persistPullRequest).not.toHaveBeenCalled();
  });

  it("does not mutate state when a pull request already exists", async () => {
    const { service, setPullRequestClientState } = createHarness({
      clientState: {
        pullRequest: {
          status: "created",
          number: 9,
          url: "https://github.com/ben/repo/pull/9",
          state: "open",
        },
      },
    });

    await expect(service.handleCreatePullRequest()).resolves.toEqual({
      ok: false,
      error: {
        code: "PULL_REQUEST_ALREADY_EXISTS",
        status: 409,
        message: "Pull request already exists",
        url: "https://github.com/ben/repo/pull/9",
      },
    });
    expect(setPullRequestClientState).not.toHaveBeenCalled();
  });

  it("updates created pull request state and persists it", async () => {
    const { service, sessionSummaryService, setPullRequestClientState } = createHarness({
      clientState: {
        pullRequest: {
          status: "created",
          number: 12,
          url: "https://github.com/ben/repo/pull/12",
          state: "open",
        },
      },
    });

    await expect(service.updatePullRequest({ state: "merged" })).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    expect(setPullRequestClientState).toHaveBeenCalledWith({
      status: "created",
      number: 12,
      url: "https://github.com/ben/repo/pull/12",
      state: "merged",
    });
    expect(sessionSummaryService.persistPullRequestState).toHaveBeenCalledWith("merged");
  });

  it("does not update pull request state when no pull request exists", async () => {
    const { service, sessionSummaryService, setPullRequestClientState } = createHarness();

    await expect(service.updatePullRequest({ state: "closed" })).resolves.toEqual({
      ok: false,
      error: {
        code: "PULL_REQUEST_NOT_FOUND",
        message: "Pull request not found",
      },
    });

    expect(setPullRequestClientState).not.toHaveBeenCalled();
    expect(sessionSummaryService.persistPullRequestState).not.toHaveBeenCalled();
  });
});
