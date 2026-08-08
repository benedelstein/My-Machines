import {
  failure,
  success,
  type ClientState,
  type SessionInfoResponse,
  type SessionPlanResponse,
  type SessionSetupOutputResponse,
} from "@repo/shared";
import type {
  HandleGetMessagesResult,
  HandleGetPlanResult,
  HandleGetSessionResult,
  HandleGetSetupOutputResult,
} from "@/shared/types/session-agent";
import type { LatestPlanRepository } from "../repositories/latest-plan.repository";
import type { MessageRepository } from "../repositories/message.repository";
import {
  SETUP_OUTPUT_STORE_CAP,
  type SetupOutputRepository,
} from "../repositories/setup-output.repository";
import type { ServerState } from
  "../types/server-state.types";

export interface SessionQueryServiceDeps {
  messageRepository: MessageRepository;
  latestPlanRepository: LatestPlanRepository;
  setupOutputRepository: SetupOutputRepository;
  getSetupOutputEpoch: () => string;
  getServerState: () => ServerState;
  getClientState: () => ClientState;
}

export class SessionQueryService {
  private readonly messageRepository: MessageRepository;
  private readonly latestPlanRepository: LatestPlanRepository;
  private readonly setupOutputRepository: SetupOutputRepository;
  private readonly getSetupOutputEpoch: () => string;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;

  constructor(deps: SessionQueryServiceDeps) {
    this.messageRepository = deps.messageRepository;
    this.latestPlanRepository = deps.latestPlanRepository;
    this.setupOutputRepository = deps.setupOutputRepository;
    this.getSetupOutputEpoch = deps.getSetupOutputEpoch;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
  }

  handleGetSession(): HandleGetSessionResult {
    const serverState = this.getServerState();
    const clientState = this.getClientState();
    const sessionId = serverState.sessionId;
    if (!sessionId || !clientState.repoFullName) {
      return failure({ code: "SESSION_NOT_INITIALIZED", message: "Session not found" });
    }
    const pullRequest = clientState.pullRequest?.status === "created" ? clientState.pullRequest : null;

    return success({
      sessionId,
      title: null,
      status: clientState.status,
      repoFullName: clientState.repoFullName,
      baseBranch: clientState.baseBranch ?? undefined,
      pushedBranch: clientState.pushedBranch ?? undefined,
      pullRequestUrl: pullRequest?.url ?? undefined,
      pullRequestNumber: pullRequest?.number ?? undefined,
      pullRequestState: pullRequest?.state ?? undefined,
      editorUrl: clientState.editorUrl ?? undefined,
    } satisfies SessionInfoResponse);
  }

  handleGetMessages(): HandleGetMessagesResult {
    const sessionId = this.getServerState().sessionId;
    if (!sessionId) {
      return failure({ code: "SESSION_NOT_INITIALIZED", message: "Session not found" });
    }

    return success(
      this.messageRepository
        .getAllBySession(sessionId)
        .map((message) => message.message),
    );
  }

  handleGetPlan(): HandleGetPlanResult {
    const sessionId = this.getServerState().sessionId;
    if (!sessionId) {
      return failure({ code: "SESSION_NOT_INITIALIZED", message: "Session not found" });
    }

    const latestPlan = this.latestPlanRepository.getBySession(sessionId);
    if (!latestPlan) {
      return failure({ code: "PLAN_NOT_FOUND", message: "Plan not found" });
    }

    return success({
      plan: latestPlan.plan,
      updatedAt: latestPlan.updatedAt,
      sourceMessageId: latestPlan.sourceMessageId,
    } satisfies SessionPlanResponse);
  }

  handleGetSetupOutput(): HandleGetSetupOutputResult {
    const serverState = this.getServerState();
    if (!serverState.sessionId) {
      return failure({ code: "SESSION_NOT_INITIALIZED", message: "Session not found" });
    }

    const completed = serverState.startupScriptCompleted;
    // Completed runs with no stored output: either the script never produced
    // output or it predates output streaming (legacy inline output).
    if (completed && !this.setupOutputRepository.hasOutput()) {
      return failure({ code: "SETUP_OUTPUT_NOT_FOUND", message: "Setup output not found" });
    }

    const stdout = this.setupOutputRepository.read("stdout");
    const stderr = this.setupOutputRepository.read("stderr");
    return success({
      taskId: "setup_script",
      epoch: this.getSetupOutputEpoch(),
      stdout,
      stderr,
      truncated:
        stdout.length >= SETUP_OUTPUT_STORE_CAP
        || stderr.length >= SETUP_OUTPUT_STORE_CAP,
      completed,
    } satisfies SessionSetupOutputResponse);
  }
}
