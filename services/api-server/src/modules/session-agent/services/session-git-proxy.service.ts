import type { ClientState, Logger } from "@repo/shared";
import type { Env } from "@/shared/types";
import type { SecretRepository } from "../repositories/secret.repository";
import type { ServerState } from "../repositories/server-state.repository";
import type {
  SessionRepoAccessError,
  SessionRepoAccessResult,
} from "@/shared/types/repo-access";
import type { GitHubAppResult } from "@/shared/types/github";
import { GitProxyService } from "@/shared/integrations/git/git-proxy.service";
import type {
  GitProxyProviderError,
  GitProxyProviderResult,
  GitProxyRepoPolicyProvider,
  GitProxySecretProvider,
  GitProxyTokenProvider,
} from "@/shared/integrations/git/git.providers";

export interface SessionGitProxyServiceDeps {
  logger: Logger;
  env: Env;
  secretRepository: SecretRepository;
  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updatePartialState: (partial: Partial<ClientState>) => void;
  updatePushedBranch: (branch: string) => void;
  assertSessionRepoAccess: () => Promise<SessionRepoAccessResult>;
  enforceSessionAccessBlocked: () => Promise<void>;
  githubTokenProvider: {
    getInstallationTokenForRepo(repoFullName: string): Promise<GitHubAppResult<string>>;
  };
}

/**
 * Session-scoped adapter around the agnostic `GitProxyService`.
 * Resolves the expected request bearer from `SecretRepository` and owns
 * access-control/pushed-branch state mutation. Installation tokens stay
 * in the GitHub module's D1 token cache.
 */
export class SessionGitProxyService implements
  GitProxyTokenProvider,
  GitProxySecretProvider,
  GitProxyRepoPolicyProvider
{
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly secretRepository: SecretRepository;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly updatePartialState: SessionGitProxyServiceDeps["updatePartialState"];
  private readonly updatePushedBranch: (branch: string) => void;
  private readonly assertSessionRepoAccess: () => Promise<SessionRepoAccessResult>;
  private readonly enforceSessionAccessBlocked: () => Promise<void>;
  private readonly githubTokenProvider: SessionGitProxyServiceDeps["githubTokenProvider"];
  private readonly gitProxyService: GitProxyService;

  constructor(deps: SessionGitProxyServiceDeps) {
    this.logger = deps.logger.scope("session-git-proxy");
    this.env = deps.env;
    this.secretRepository = deps.secretRepository;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.updatePartialState = deps.updatePartialState;
    this.updatePushedBranch = deps.updatePushedBranch;
    this.assertSessionRepoAccess = deps.assertSessionRepoAccess;
    this.enforceSessionAccessBlocked = deps.enforceSessionAccessBlocked;
    this.githubTokenProvider = deps.githubTokenProvider;
    this.gitProxyService = new GitProxyService({
      tokenProvider: this,
      secretProvider: this,
      repoPolicyProvider: this,
      logger: this.logger,
    });
  }

  /**
   * Authenticates the session's repo access, forwards the git request to
   * GitHub, and propagates any pushed-branch update into DO state.
   */
  async handleRequest(request: Request): Promise<Response> {
    const accessResult = await this.assertSessionRepoAccess();
    if (!accessResult.ok) {
      return this.respondToAccessFailure(accessResult.error);
    }

    const path = new URL(request.url).pathname;
    const result = await this.gitProxyService.handleRequest(request, path);

    if (result.pushedBranch && result.response.ok) {
      const clientState = this.getClientState();
      if (result.pushedBranch !== clientState.pushedBranch) {
        this.updatePartialState({ pushedBranch: result.pushedBranch });
        this.updatePushedBranch(result.pushedBranch);
      }
    }

    return result.response;
  }

  getExpectedBearerToken(): string | null {
    // Once git is configured through the session connector, the only accepted
    // credential is the gateway-injected session token; the legacy Sprite-held
    // secret is rejected so an extracted bearer cannot be replayed.
    if (this.getServerState().gitConfiguredViaConnector) {
      return this.secretRepository.get("webhook_token");
    }
    return this.secretRepository.get("git_proxy_secret");
  }

  getAllowedRepoFullName(): string | null {
    return this.getClientState().repoFullName;
  }

  getSessionId(): string | null {
    return this.getServerState().sessionId;
  }

  getPushedBranch(): string | null {
    return this.getClientState().pushedBranch;
  }

  async getInstallationTokenForRepo(
    repoFullName: string,
  ): Promise<GitProxyProviderResult<string>> {
    const tokenResult = await this.githubTokenProvider.getInstallationTokenForRepo(repoFullName);
    if (tokenResult.ok) {
      return tokenResult;
    }

    return {
      ok: false,
      error: this.mapGitHubTokenError(tokenResult.error),
    };
  }

  private mapGitHubTokenError(error: {
    code: string;
    message: string;
  }): GitProxyProviderError {
    switch (error.code) {
      case "INVALID_REPO":
        return { code: "INVALID_REPO", status: 400, message: error.message };
      case "REPO_NOT_ACCESSIBLE":
        return { code: "REPO_NOT_ACCESSIBLE", status: 403, message: error.message };
      case "INSTALLATION_NOT_FOUND":
        return { code: "INSTALLATION_NOT_FOUND", status: 404, message: error.message };
      case "GITHUB_AUTH_ERROR":
        return { code: "GITHUB_AUTH_ERROR", status: 503, message: error.message };
      case "GITHUB_API_ERROR":
        return { code: "GITHUB_API_ERROR", status: 503, message: error.message };
      default:
        return { code: "TOKEN_UNAVAILABLE", status: 503, message: error.message };
    }
  }

  private async respondToAccessFailure(
    error: SessionRepoAccessError,
  ): Promise<Response> {
    switch (error.code) {
      case "REPO_ACCESS_BLOCKED":
        await this.enforceSessionAccessBlocked();
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          {
            status: error.status,
            headers: { "Content-Type": "application/json" },
          },
        );
      case "GITHUB_AUTH_REQUIRED":
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      case "GITHUB_API_ERROR":
      case "GITHUB_UNAVAILABLE":
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      case "SESSION_NOT_FOUND":
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      case "INVALID_REPO":
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      default: {
        const exhaustiveCheck: never = error;
        this.logger.error("Unhandled session repo access error", {
          fields: { error: JSON.stringify(exhaustiveCheck) },
        });
        throw new Error(
          `Unhandled session repo access error: ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }
}
