import {
  failure,
  success,
  type ClientState,
  type Logger,
  type PullRequestResponse,
  type PullRequestState,
  type Result,
} from "@repo/shared";
import type { UIMessage } from "ai";
import type { MessageRepository } from "@/modules/session-agent/repositories/message.repository";
import type { ServerState } from
  "@/modules/session-agent/types/server-state.types";
import type { SessionSummaryService } from "@/modules/session-agent/services/session-summary.service";
import type {
  CreatedPullRequestResult,
  CreatePullRequestForSessionContextParams,
  PullRequestCreationError,
  SessionPullRequestGitHubProvider,
} from "@/modules/sessions/services/session-pull-request.service";
import type {
  HandleCreatePullRequestResult,
  HandleUpdatePullRequestResult,
  SessionAgentRpcError,
  UpdatePullRequestRequest,
} from "@/shared/types/session-agent";
import { sanitizeGitBranchName } from "@/shared/utils/git-branch";

interface PullRequestCreationContext {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  sessionMessages: UIMessage[];
  sessionUrl?: string;
}

type PullRequestCreationContextError = Extract<
  SessionAgentRpcError,
  {
    code:
      | "SESSION_NOT_INITIALIZED"
      | "BRANCH_NOT_PUSHED"
      | "PULL_REQUEST_ALREADY_EXISTS"
      | "PULL_REQUEST_CREATE_IN_PROGRESS"
      | "INVALID_REPO";
  }
>;

type PullRequestCreationContextResult = Result<
  PullRequestCreationContext,
  PullRequestCreationContextError
>;

export type SessionPullRequestCreator = (
  params: CreatePullRequestForSessionContextParams,
) => Promise<Result<CreatedPullRequestResult, PullRequestCreationError>>;

export interface SessionPullRequestLifecycleServiceDeps {
  logger: Logger;
  github: SessionPullRequestGitHubProvider;
  anthropicApiKey: string;
  webOrigin: string;
  createPullRequest: SessionPullRequestCreator;
  messageRepository: MessageRepository;
  sessionSummaryService: SessionSummaryService;
  getServerState: () => ServerState;
  getClientState: () => ClientState;
  setPullRequestClientState: (pullRequest: ClientState["pullRequest"]) => void;
}

export class SessionPullRequestLifecycleService {
  private readonly logger: Logger;
  private readonly github: SessionPullRequestGitHubProvider;
  private readonly anthropicApiKey: string;
  private readonly webOrigin: string;
  private readonly createPullRequest: SessionPullRequestCreator;
  private readonly messageRepository: MessageRepository;
  private readonly sessionSummaryService: SessionSummaryService;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly setPullRequestClientState:
    SessionPullRequestLifecycleServiceDeps["setPullRequestClientState"];

  constructor(deps: SessionPullRequestLifecycleServiceDeps) {
    this.logger = deps.logger.scope("session-pull-request-lifecycle");
    this.github = deps.github;
    this.anthropicApiKey = deps.anthropicApiKey;
    this.webOrigin = deps.webOrigin;
    this.createPullRequest = deps.createPullRequest;
    this.messageRepository = deps.messageRepository;
    this.sessionSummaryService = deps.sessionSummaryService;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.setPullRequestClientState = deps.setPullRequestClientState;
  }

  async handleCreatePullRequest(): Promise<HandleCreatePullRequestResult> {
    const contextResult = this.getCreationContext();
    if (!contextResult.ok) {
      return contextResult;
    }

    this.setPullRequestClientState({ status: "creating" });
    const creationResult = await this.createPullRequest({
      github: this.github,
      anthropicApiKey: this.anthropicApiKey,
      ...contextResult.value,
    });

    if (!creationResult.ok) {
      const pullRequest = {
        status: "failed" as const,
        error: creationResult.error.message,
        ...(creationResult.error.details ? { details: creationResult.error.details } : {}),
      };
      this.setPullRequestClientState(pullRequest);
      return failure({
        code: "PULL_REQUEST_CREATE_FAILED",
        status: 400,
        message: creationResult.error.message,
        details: creationResult.error.details,
      });
    }

    const pullRequest = {
      status: "created" as const,
      url: creationResult.value.url,
      number: creationResult.value.number,
      state: creationResult.value.state,
    };
    this.setPullRequestClientState(pullRequest);
    await this.persistPullRequest(creationResult.value);
    return success(creationResult.value);
  }

  async updatePullRequest(data: UpdatePullRequestRequest): Promise<HandleUpdatePullRequestResult> {
    const pullRequest = this.getClientState().pullRequest;
    if (!pullRequest || pullRequest.status !== "created") {
      return failure({ code: "PULL_REQUEST_NOT_FOUND", message: "Pull request not found" });
    }

    this.setPullRequestClientState({ ...pullRequest, state: data.state });
    await this.sessionSummaryService.persistPullRequestState(data.state);
    return success(undefined);
  }

  private getCreationContext(): PullRequestCreationContextResult {
    const serverState = this.getServerState();
    const sessionId = serverState.sessionId;
    const clientState = this.getClientState();
    const repoFullName = clientState.repoFullName;
    if (!sessionId || !repoFullName) {
      return failure({ code: "SESSION_NOT_INITIALIZED", message: "Session not found" });
    }

    const pullRequest = clientState.pullRequest;
    if (pullRequest?.status === "created") {
      return failure({
        code: "PULL_REQUEST_ALREADY_EXISTS",
        status: 409,
        message: "Pull request already exists",
        url: pullRequest.url,
      });
    }
    if (pullRequest?.status === "creating") {
      return failure({
        code: "PULL_REQUEST_CREATE_IN_PROGRESS",
        status: 409,
        message: "Pull request creation is already in progress",
      });
    }

    if (!clientState.pushedBranch) {
      return failure({
        code: "BRANCH_NOT_PUSHED",
        status: 400,
        message: "No branch has been pushed yet",
      });
    }

    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      return failure({
        code: "INVALID_REPO",
        status: 400,
        message: "Invalid repoFullName",
      });
    }

    return success({
      repoFullName,
      baseBranch: sanitizeGitBranchName(clientState.baseBranch) ?? "main",
      headBranch: clientState.pushedBranch,
      sessionMessages: this.messageRepository
        .getAllBySession(sessionId)
        .map((message) => message.message),
      ...this.buildSessionUrl(sessionId),
    });
  }

  private buildSessionUrl(sessionId: string): { sessionUrl?: string } {
    const origin = this.webOrigin.trim().replace(/\/$/, "");
    if (!origin) {
      return {};
    }

    return { sessionUrl: `${origin}/session/${encodeURIComponent(sessionId)}` };
  }

  private async persistPullRequest(pullRequest: PullRequestResponse): Promise<void> {
    const persistedPullRequest: { url: string; number: number; state: PullRequestState } = {
      url: pullRequest.url,
      number: pullRequest.number,
      state: "open",
    };
    try {
      await this.sessionSummaryService.persistPullRequest(persistedPullRequest);
    } catch (error) {
      // The PR exists on GitHub and live ClientState has already been updated.
      this.logger.error("Failed to persist PR state in session after creation", { error });
    }
  }
}
