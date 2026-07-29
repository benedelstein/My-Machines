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
  authenticateGitRequest(authorization: string | null): boolean;
}

export interface GitProxyRepoPolicyProvider {
  getAllowedRepoFullName(): string | null;
  getSessionId(): string | null;
  getPushedBranch(): string | null;
}
