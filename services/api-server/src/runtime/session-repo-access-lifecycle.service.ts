import type {
  ClientState,
  Logger,
  ServerMessage,
} from "@repo/shared";
import { UserSessionService } from "@/modules/auth/services/user-session.service";
import { GitHubAppService } from "@/modules/github/services/github-app.service";
import { assertSessionRepoAccess } from "@/modules/sessions/services/session-repo-access.service";
import type { Env } from "@/shared/types";
import type { SessionRepoAccessResult } from "@/shared/types/repo-access";
import type { ServerState } from
  "@/modules/session-agent/types/server-state.types";

const repoAccessBlockedMessage =
  "Repository access for this session is blocked. Update the GitHub App installation or your GitHub access to continue.";

type OperationErrorMessage = Extract<ServerMessage, { type: "operation.error" }>;

export type SessionRepoAccessGuardResult =
  | { ok: true }
  | { ok: false; message: OperationErrorMessage };

export type SessionRepoAccessChecker = (input: {
  env: Env;
  logger: Logger;
  sessionId: string;
  userId: string;
}) => Promise<SessionRepoAccessResult>;

export interface SessionRepoAccessLifecycleServiceDeps {
  logger: Logger;
  env: Env;
  getServerState: () => ServerState;
  updatePartialState: (partial: Partial<Pick<ClientState, "lastError">>) => void;
  cancelActiveTurnAndClearState: () => Promise<void>;
  killActiveProcess: () => Promise<void>;
  assertSessionRepoAccess?: SessionRepoAccessChecker;
}

export class SessionRepoAccessLifecycleService {
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly getServerState: () => ServerState;
  private readonly updatePartialState:
    SessionRepoAccessLifecycleServiceDeps["updatePartialState"];
  private readonly cancelActiveTurnAndClearState: () => Promise<void>;
  private readonly killActiveProcess: () => Promise<void>;
  private readonly checkSessionRepoAccess: SessionRepoAccessChecker;

  constructor(deps: SessionRepoAccessLifecycleServiceDeps) {
    this.logger = deps.logger.scope("session-repo-access-lifecycle");
    this.env = deps.env;
    this.getServerState = deps.getServerState;
    this.updatePartialState = deps.updatePartialState;
    this.cancelActiveTurnAndClearState = deps.cancelActiveTurnAndClearState;
    this.killActiveProcess = deps.killActiveProcess;
    this.checkSessionRepoAccess = deps.assertSessionRepoAccess ?? defaultAssertSessionRepoAccess;
  }

  async assertSessionRepoAccess(): Promise<SessionRepoAccessResult> {
    const sessionId = this.getServerState().sessionId;
    const userId = this.getServerState().userId;
    if (!sessionId || !userId) {
      return {
        ok: false,
        error: {
          code: "SESSION_NOT_FOUND",
          status: 404,
          message: "Session not found",
        },
      };
    }

    return this.checkSessionRepoAccess({
      env: this.env,
      logger: this.logger,
      sessionId,
      userId,
    });
  }

  async guardSessionRepoAccess(): Promise<SessionRepoAccessGuardResult> {
    const accessResult = await this.assertSessionRepoAccess();
    if (accessResult.ok) {
      return { ok: true };
    }

    switch (accessResult.error.code) {
      case "REPO_ACCESS_BLOCKED":
        await this.enforceSessionAccessBlocked(false);
        return {
          ok: false,
          message: {
            type: "operation.error",
            code: "REPO_ACCESS_BLOCKED",
            message: accessResult.error.message,
          },
        };
      case "GITHUB_AUTH_REQUIRED":
        return {
          ok: false,
          message: {
            type: "operation.error",
            code: "GITHUB_AUTH_REQUIRED",
            message: accessResult.error.message,
          },
        };
      case "GITHUB_API_ERROR":
      case "GITHUB_UNAVAILABLE":
      case "INVALID_REPO":
      case "SESSION_NOT_FOUND":
        return {
          ok: false,
          message: {
            type: "operation.error",
            code: "MESSAGE_HANDLER_ERROR",
            message: accessResult.error.message,
          },
        };
    }
  }

  async enforceSessionAccessBlocked(notifyClients = true): Promise<OperationErrorMessage | null> {
    this.updatePartialState({ lastError: repoAccessBlockedMessage });
    await this.cancelActiveTurnAndClearState();
    await this.killActiveProcess();

    if (!notifyClients) {
      return null;
    }

    return {
      type: "operation.error",
      code: "REPO_ACCESS_BLOCKED",
      message: repoAccessBlockedMessage,
    };
  }
}

async function defaultAssertSessionRepoAccess(input: {
  env: Env;
  logger: Logger;
  sessionId: string;
  userId: string;
}): Promise<SessionRepoAccessResult> {
  const github = new GitHubAppService(input.env, input.logger.scope("github"));
  return assertSessionRepoAccess({
    env: input.env,
    sessionId: input.sessionId,
    userId: input.userId,
    providers: {
      github,
      userTokens: new UserSessionService({
        env: input.env,
        githubTokenRefreshProvider: github,
      }),
    },
  });
}
