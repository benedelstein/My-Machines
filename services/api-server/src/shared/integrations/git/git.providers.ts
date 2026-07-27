export interface GitProxyProviderError {
  code:
    | "INVALID_REPO"
    | "INSTALLATION_NOT_FOUND"
    | "REPO_NOT_ACCESSIBLE"
    | "GITHUB_AUTH_ERROR"
    | "GITHUB_API_ERROR"
    | "TOKEN_UNAVAILABLE";
  message: string;
  status: 400 | 403 | 404 | 503;
}

export type GitProxyProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitProxyProviderError };

export interface GitProxyTokenProvider {
  getInstallationTokenForRepo(
    repoFullName: string,
  ): Promise<GitProxyProviderResult<string>>;
}

export interface GitProxySecretProvider {
  /**
   * The bearer token the git-proxy must receive on this session's requests:
   * the gateway-injected session token once git is configured through the
   * connector, otherwise the legacy Sprite-held git-proxy secret.
   */
  getExpectedBearerToken(): string | null;
}

export interface GitProxyRepoPolicyProvider {
  getAllowedRepoFullName(): string | null;
  getSessionId(): string | null;
  getPushedBranch(): string | null;
}
