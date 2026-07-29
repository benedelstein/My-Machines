import type { ClientState, Logger } from "@repo/shared";
import type { Env } from "@/shared/types";
import type { SecretRepository } from "../repositories/secret.repository";
import type { ServerState } from "../repositories/server-state.repository";
import type {
  SessionRepoAccessError,
  SessionRepoAccessResult,
} from "@/shared/types/repo-access";
import type { GitHubAppResult } from "@/shared/types/github";
import { z } from "zod";
import { timingSafeCompare } from "@/shared/utils/crypto";
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

const EPHEMERAL_GIT_TOKEN_TTL_MS = 5 * 60 * 1000;
const EPHEMERAL_GIT_TOKEN_ROTATION_WINDOW_MS = 60 * 1000;
const EPHEMERAL_GIT_TOKEN_USERNAME = "x-ephemeral-git-token";

const EphemeralGitTokenEntrySchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

const StoredEphemeralGitTokenSchema = z.object({
  current: EphemeralGitTokenEntrySchema,
  previous: EphemeralGitTokenEntrySchema.optional(),
});

export type MintedEphemeralGitToken = z.infer<typeof EphemeralGitTokenEntrySchema>;

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

  /** Removes the legacy session-long Git bearer after ephemeral-token cutover. */
  retireGitProxySecret(): void {
    this.secretRepository.delete("git_proxy_secret");
  }

  /**
   * Mints or reuses the session's ephemeral Git token.
   * The read/rotate/write sequence is synchronous inside the Durable Object.
   */
  mintEphemeralGitToken(): MintedEphemeralGitToken | null {
    if (this.getServerState().gitAuthMode !== "ephemeral_token") {
      return null;
    }

    const now = Date.now();
    const stored = this.readEphemeralGitToken();
    if (stored && stored.current.expiresAt - now > EPHEMERAL_GIT_TOKEN_ROTATION_WINDOW_MS) {
      return stored.current;
    }

    const current = {
      token: randomBase64Url(32),
      expiresAt: now + EPHEMERAL_GIT_TOKEN_TTL_MS,
    };
    const previous = stored?.current.expiresAt && stored.current.expiresAt > now
      ? stored.current
      : undefined;
    this.secretRepository.set(
      "ephemeral_git_token",
      JSON.stringify({ current, ...(previous ? { previous } : {}) }),
    );
    return current;
  }

  /** Revokes all outstanding ephemeral Git tokens for the session. */
  revokeEphemeralGitTokens(): void {
    this.secretRepository.delete("ephemeral_git_token");
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

  authenticateGitRequest(authorization: string | null): boolean {
    const mode = this.getServerState().gitAuthMode;
    if (mode === "legacy_secret") {
      const expected = this.secretRepository.get("git_proxy_secret");
      const presented = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
      return Boolean(expected && presented && timingSafeCompare(expected, presented));
    }

    const basic = parseBasicAuthorization(authorization);
    if (!basic || basic.username !== EPHEMERAL_GIT_TOKEN_USERNAME) {
      return false;
    }
    const now = Date.now();
    const stored = this.readEphemeralGitToken();
    if (!stored) {
      return false;
    }

    const currentValid = stored.current.expiresAt > now
      && timingSafeCompare(stored.current.token, basic.password);
    const previousValid = stored.previous !== undefined
      && stored.previous.expiresAt > now
      && timingSafeCompare(stored.previous.token, basic.password);

    const previous = stored.previous?.expiresAt && stored.previous.expiresAt > now
      ? stored.previous
      : undefined;
    if (stored.current.expiresAt <= now) {
      this.secretRepository.delete("ephemeral_git_token");
    } else if (stored.previous && !previous) {
      this.secretRepository.set("ephemeral_git_token", JSON.stringify({ current: stored.current }));
    }
    return currentValid || previousValid;
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

  private readEphemeralGitToken(): z.infer<typeof StoredEphemeralGitTokenSchema> | null {
    const raw = this.secretRepository.get("ephemeral_git_token");
    if (!raw) {
      return null;
    }
    try {
      const parsed = StoredEphemeralGitTokenSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Invalid persisted secret is revoked below.
    }
    this.secretRepository.delete("ephemeral_git_token");
    return null;
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

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function parseBasicAuthorization(
  authorization: string | null,
): { username: string; password: string } | null {
  const encoded = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}
