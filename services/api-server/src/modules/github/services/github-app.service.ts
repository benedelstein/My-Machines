import { App, Octokit } from "octokit";
import {
  buildGitHubAppInstallUrl,
  failure,
  success,
  type Logger,
} from "@repo/shared";
import { decrypt, encrypt } from "@/shared/utils/crypto";
import type { Env } from "@/shared/types";
import { GitHubInstallationRepository } from "../repositories/github-installation.repository";
import type {
  GitHubInstallationWithRepo,
  RepositorySelection,
} from "../repositories/github-installation.repository";
import { GitHubUserRepoAccessCacheRepository } from "../repositories/github-user-repo-access-cache.repository";
import { InstallationTokenCacheRepository } from "../repositories/installation-token-cache.repository";
import type {
  CreatePullRequestInput,
  GitHubAppResult,
  GitHubCompareData,
  GitHubRepositoryData,
  GithubOAuthTokenResult,
  PullRequestData,
  RefreshedToken,
} from "../types/github-app.types";
export type {
  CreatePullRequestInput,
  GitHubAppErrorCode,
  GitHubAppResult,
  GitHubAppServiceError,
  GitHubCompareData,
  GitHubRepositoryData,
  GithubOAuthTokenResult,
  GithubOAuthUser,
  PullRequestData,
  RefreshedToken,
} from "../types/github-app.types";

const USER_REPO_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatGitHubErrorDetails(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const status = typeof error.status === "number" ? error.status : null;
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : null;

  if (status && message) {
    return `GitHub returned ${status}: ${message}`;
  }
  if (message) {
    return message;
  }
  if (status) {
    return `GitHub returned ${status}`;
  }
  return undefined;
}

export interface GitHubInstallationSummary {
  id: number;
}

export interface GitHubBranchSummary {
  name: string;
  default: boolean;
}

export interface GitHubBranchList {
  repoName: string;
  branches: GitHubBranchSummary[];
  nextCursor: string | null;
}

export class GitHubAppService {
  private readonly app: App;
  private readonly env: Env;
  private readonly installationRepository: GitHubInstallationRepository;
  private readonly userRepoAccessCacheRepository: GitHubUserRepoAccessCacheRepository;
  private readonly tokenCacheRepository: InstallationTokenCacheRepository;
  private readonly clientId: string;
  private readonly appSlug: string;
  private readonly logger: Logger;
  private readonly tokenEncryptionKey: string;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: atob(env.GITHUB_APP_PRIVATE_KEY),
      webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
      oauth: {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      },
    });
    this.installationRepository = new GitHubInstallationRepository(env.DB);
    this.userRepoAccessCacheRepository = new GitHubUserRepoAccessCacheRepository(env.DB);
    this.tokenCacheRepository = new InstallationTokenCacheRepository(env.DB);
    this.clientId = env.GITHUB_APP_CLIENT_ID;
    this.appSlug = env.GITHUB_APP_SLUG;
    this.logger = logger.scope("github-app.ts");
    this.tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY;
  }

  /**
   * Returns the GitHub OAuth authorization URL.
   * For users who already have the app installed, this goes straight to OAuth.
   * New users will need to install the app separately (or be directed to /installations/new).
   */
  getAuthUrl(state: string): string {
    return `https://github.com/login/oauth/authorize?client_id=${this.clientId}&state=${state}`;
  }

  /**
   * Returns the GitHub App installation URL (for users who need to install the app).
   */
  getInstallUrl(): string {
    return buildGitHubAppInstallUrl(this.appSlug);
  }

  async hasInstallations(accessToken: string): Promise<boolean> {
    const octokit = new Octokit({ auth: accessToken });
    return octokit.request("GET /user/installations", { per_page: 1 })
      .then(({ data }) => data.total_count > 0);
  }

  /**
   * Exchange an OAuth authorization code for user tokens + profile info.
   */
  async exchangeOAuthCode(code: string): Promise<GithubOAuthTokenResult> {
    const { authentication } = await this.app.oauth.createToken({ code });

    // Fetch user profile with the new token
    const userOctokit = new Octokit({ auth: authentication.token });
    const { data: ghUser } = await userOctokit.rest.users.getAuthenticated();

    return {
      accessToken: authentication.token,
      refreshToken: authentication.refreshToken,
      refreshTokenExpiresAt: authentication.refreshTokenExpiresAt,
      expiresAt: authentication.expiresAt,
      user: {
        id: ghUser.id,
        login: ghUser.login,
        name: ghUser.name,
        avatarUrl: ghUser.avatar_url,
      },
    };
  }

  /**
   * Refresh an expired user access token using a refresh token.
   */
  async refreshUserToken(refreshToken: string): Promise<RefreshedToken> {
    const { authentication } = await this.app.oauth.refreshToken({
      refreshToken,
    });

    return {
      accessToken: authentication.token,
      refreshToken: authentication.refreshToken,
      expiresAt: authentication.expiresAt,
      refreshTokenExpiresAt: authentication.refreshTokenExpiresAt,
    };
  }

  async listInstallationsForAuthenticatedUser(
    accessToken: string,
  ): Promise<GitHubInstallationSummary[]> {
    const octokit = new Octokit({ auth: accessToken });
    const installations = await octokit.paginate(
      octokit.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
    return installations.map((installation) => ({ id: installation.id }));
  }

  async listInstallationReposForAuthenticatedUser(params: {
    accessToken: string;
    installationId: number;
  }): Promise<GitHubRepositoryData[]> {
    const octokit = new Octokit({ auth: params.accessToken });
    const repositories = await octokit.paginate(
      octokit.rest.apps.listInstallationReposForAuthenticatedUser,
      {
        installation_id: params.installationId,
        per_page: 100,
      },
    );
    return repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.full_name,
      owner: repository.owner.login,
      name: repository.name,
      defaultBranch: repository.default_branch,
      private: repository.private,
      description: repository.description,
    }));
  }

  async listBranchesForRepo(params: {
    accessToken: string;
    repoId: number;
    limit: number;
    page: number;
  }): Promise<GitHubBranchList> {
    const octokit = new Octokit({ auth: params.accessToken });
    const { data: repo } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: params.repoId,
    });
    const response = await octokit.rest.repos.listBranches({
      owner: repo.owner.login,
      repo: repo.name,
      per_page: params.limit,
      page: params.page,
    });

    return {
      repoName: repo.name,
      branches: response.data.map((branch) => ({
        name: branch.name,
        default: branch.name === repo.default_branch,
      })),
      nextCursor: getNextPageCursor(response.headers.link),
    };
  }

  async getRepositoryReadme(params: {
    accessToken: string;
    owner: string;
    repo: string;
  }): Promise<string | null> {
    const octokit = new Octokit({ auth: params.accessToken });
    try {
      const response = await octokit.rest.repos.getReadme({
        owner: params.owner,
        repo: params.repo,
      });
      if (Array.isArray(response.data) || response.data.encoding !== "base64") {
        return null;
      }
      return decodeBase64Text(response.data.content);
    } catch (error) {
      if (isHttpStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Resolve a repo (owner/name) to an installation access token.
   * Checks D1 for installation, verifies repo access, and returns a cached or fresh token.
   */
  async getInstallationTokenForRepo(repoFullName: string): Promise<GitHubAppResult<string>> {
    const repoParts = this.parseRepoFullName(repoFullName);
    if (!repoParts.ok) {
      return repoParts;
    }

    const { owner, repo } = repoParts.value;
    const installationResult = await this.findInstallationForRepo(owner, repo);
    if (!installationResult.ok) {
      return installationResult;
    }

    try {
      const numericRepoId = await this.getNumericRepoId(
        installationResult.value.id,
        owner,
        repo,
      );
      const token = await this.getInstallationToken(
        installationResult.value.id,
        { repoName: repo, repoId: numericRepoId },
      );
      return success(token);
    } catch (error) {
      return this.githubApiFailure(
        `Failed to resolve installation token for ${repoFullName}.`,
        error,
      );
    }
  }

  /**
   * Get a read-only token for a repo, scoped to contents:read only.
   * Used for initial clone where write access is not needed.
   */
  async getReadOnlyTokenForRepo(repoFullName: string): Promise<GitHubAppResult<string>> {
    const repoParts = this.parseRepoFullName(repoFullName);
    if (!repoParts.ok) {
      return repoParts;
    }

    const { owner, repo } = repoParts.value;
    const installationResult = await this.findInstallationForRepo(owner, repo);
    if (!installationResult.ok) {
      return installationResult;
    }

    try {
      const numericRepoId = await this.getNumericRepoId(
        installationResult.value.id,
        owner,
        repo,
      );
      const token = await this.getInstallationToken(
        installationResult.value.id,
        { repoName: repo, repoId: numericRepoId },
        { contents: "read", metadata: "read" },
      );
      return success(token);
    } catch (error) {
      return this.githubApiFailure(
        `Failed to resolve read-only installation token for ${repoFullName}.`,
        error,
      );
    }
  }

  /**
   * Compare two branches using the GitHub App installation token.
   */
  async compareBranches(
    repoFullName: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<GitHubAppResult<GitHubCompareData>> {
    const repoOctokitResult = await this.getRepoOctokit(repoFullName);
    if (!repoOctokitResult.ok) {
      return repoOctokitResult;
    }

    const { owner, repo, octokit } = repoOctokitResult.value;

    try {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseBranch}...${headBranch}`,
      });

      return success({
        aheadBy: data.ahead_by,
        totalCommits: data.total_commits,
        files: (data.files ?? []).map((file) => ({
          filename: file.filename,
          status: file.status ?? "modified",
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        })),
        commits: (data.commits ?? []).map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message ?? "",
          authorName: commit.commit.author?.name ?? null,
        })),
      });
    } catch (error) {
      return this.githubApiFailure(
        `Failed to compare branches for ${repoFullName} (${baseBranch}...${headBranch}).`,
        error,
      );
    }
  }

  /**
   * Create a pull request using the GitHub App installation token.
   */
  async createPullRequest(
    repoFullName: string,
    input: CreatePullRequestInput,
  ): Promise<GitHubAppResult<PullRequestData>> {
    const repoOctokitResult = await this.getRepoOctokit(repoFullName);
    if (!repoOctokitResult.ok) {
      return repoOctokitResult;
    }

    const { owner, repo, octokit } = repoOctokitResult.value;

    try {
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      });

      return success({
        number: data.number,
        url: data.html_url,
        state: data.state as "open" | "closed",
        merged: false,
      });
    } catch (error) {
      if (this.isPullRequestValidationError(error)) {
        const existingPullRequest = await this.findOpenPullRequestForBranch(
          repoFullName,
          input.base,
          input.head,
        );
        if (existingPullRequest.ok && existingPullRequest.value) {
          return success(existingPullRequest.value);
        }
      }

      return this.githubApiFailure(
        `Failed to create pull request for ${repoFullName} (${input.base} <- ${input.head}).`,
        error,
      );
    }
  }

  /**
   * Find an open pull request for a branch in the same repository.
   */
  async findOpenPullRequestForBranch(
    repoFullName: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<GitHubAppResult<PullRequestData | null>> {
    const repoOctokitResult = await this.getRepoOctokit(repoFullName);
    if (!repoOctokitResult.ok) {
      return repoOctokitResult;
    }

    const { owner, repo, octokit } = repoOctokitResult.value;

    try {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        base: baseBranch,
        head: `${owner}:${headBranch}`,
        per_page: 1,
      });
      const pullRequest = data[0];
      if (!pullRequest) {
        return success(null);
      }

      return success({
        number: pullRequest.number,
        url: pullRequest.html_url,
        state: pullRequest.state as "open" | "closed",
        merged: false,
      });
    } catch (error) {
      return this.githubApiFailure(
        `Failed to find open pull request for ${repoFullName}.`,
        error,
      );
    }
  }

  /**
   * Get pull request status using the GitHub App installation token.
   */
  async getPullRequest(
    repoFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubAppResult<PullRequestData>> {
    const repoOctokitResult = await this.getRepoOctokit(repoFullName);
    if (!repoOctokitResult.ok) {
      return repoOctokitResult;
    }

    const { owner, repo, octokit } = repoOctokitResult.value;

    try {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullRequestNumber,
      });

      return success({
        number: data.number,
        url: data.html_url,
        state: data.state as "open" | "closed",
        merged: data.merged,
      });
    } catch (error) {
      return this.githubApiFailure(
        `Failed to fetch pull request ${pullRequestNumber} for ${repoFullName}.`,
        error,
      );
    }
  }

  /**
   * Resolve a repo's full name (owner/repo) from its numeric GitHub ID.
   * Checks D1 first, falls back to the GitHub API.
   */
  async getRepoNameById(repoId: number, userAccessToken: string): Promise<string> {
    const installationRepo = await this.installationRepository.findInstallationRepoById(repoId);

    if (installationRepo) { return installationRepo.repoName; }

    // Fallback: query GitHub API using an app-level request
    const octokit = new Octokit({ auth: userAccessToken });
    const { data } = await octokit.request("GET /repositories/{id}", {
      id: repoId,
    });
    return data.full_name;
  }

  private buildUserRepoAccessCacheExpiry(): string {
    return new Date(Date.now() + USER_REPO_ACCESS_CACHE_TTL_MS).toISOString();
  }

  /**
   * Resolve a repo's numeric GitHub ID. Checks D1 first, falls back to the API.
   */
  private async getNumericRepoId(installationId: number, owner: string, repo: string): Promise<number> {
    const installationRepo = await this.installationRepository.findRepo(installationId, `${owner}/${repo}`);

    if (installationRepo) { return installationRepo.repoId; }

    // Fallback: query GitHub API
    const octokit = await this.app.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.id;
  }

  private async getRepoOctokit(repoFullName: string): Promise<GitHubAppResult<{
    owner: string;
    repo: string;
    octokit: Octokit;
  }>> {
    const repoParts = this.parseRepoFullName(repoFullName);
    if (!repoParts.ok) {
      return repoParts;
    }

    const { owner, repo } = repoParts.value;
    const installationResult = await this.findInstallationForRepo(owner, repo);
    if (!installationResult.ok) {
      return installationResult;
    }

    try {
      const octokit = await this.app.getInstallationOctokit(installationResult.value.id);
      return success({
        owner,
        repo,
        octokit,
      });
    } catch (error) {
      return this.githubApiFailure(
        `Failed to create installation client for ${repoFullName}.`,
        error,
      );
    }
  }

  private async cacheUserAccessibleInstallationRepos(
    userId: string,
    installationId: number,
    repositories: GitHubRepositoryData[],
  ): Promise<void> {
    await this.userRepoAccessCacheRepository.setAllowedMany(
      userId,
      installationId,
      repositories,
      this.buildUserRepoAccessCacheExpiry(),
    );
  }

  async warmUserAccessibleInstallationReposCache(
    userId: string,
    installationId: number,
    repositories: GitHubRepositoryData[],
  ): Promise<void> {
    await this.cacheUserAccessibleInstallationRepos(
      userId,
      installationId,
      repositories,
    );
  }

  async warmUserAccessibleRepoAccessCache(
    userId: string,
    entries: Array<{
      installationId: number;
      repository: GitHubRepositoryData;
    }>,
  ): Promise<void> {
    await this.userRepoAccessCacheRepository.setAllowedEntries(
      userId,
      entries,
      this.buildUserRepoAccessCacheExpiry(),
    );
  }

  async listUserAccessibleInstallationRepos(
    userId: string,
    userAccessToken: string,
    installationId: number,
  ): Promise<GitHubRepositoryData[]> {
    const userOctokit = new Octokit({ auth: userAccessToken });
    const repositories = await userOctokit.paginate(
      userOctokit.rest.apps.listInstallationReposForAuthenticatedUser,
      {
        installation_id: installationId,
        per_page: 100,
      },
    );
    const repositoryData = repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      description: repo.description,
    }));

    await this.cacheUserAccessibleInstallationRepos(
      userId,
      installationId,
      repositoryData,
    );

    return repositoryData;
  }

  /**
   * Returns true when GitHub rejects the user's OAuth token.
   */
  private isUserAuthenticationFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
      return false;
    }

    if ("status" in error && error.status === 401) {
      return true;
    }

    if ("message" in error && typeof error.message === "string") {
      return error.message.toLowerCase().includes("bad credentials");
    }

    return false;
  }

  /**
   * Finds a repo accessible by a user id for a given installation id and repo id.
   * @param userId - The user id.
   * @param userAccessToken - The user's access token.
   * @param installationId - The installation id.
   * @param repoId - The repo id to look up.
   * @returns The repository data.
   *
   * See https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
   */
  async getUserAccessibleInstallationRepoById(
    userId: string,
    userAccessToken: string,
    installationId: number,
    repoId: number,
  ): Promise<GitHubAppResult<GitHubRepositoryData>> {
    const cached = await this.userRepoAccessCacheRepository.get(
      userId,
      installationId,
      repoId,
    );
    if (cached) {
      if (!cached.allowed) {
        return failure({
          code: "REPO_NOT_ACCESSIBLE",
          message: `Repository ${repoId} is not accessible to the authenticated user`,
        });
      }

      if (cached.repoFullName) {
        const [owner, name] = cached.repoFullName.split("/");
        if (owner && name) {
          return success({
            id: repoId,
            fullName: cached.repoFullName,
            owner,
            name,
          });
        }
      }
    }

    // NOTE: this is slow, but its the only way to authoritatively know if a repo 
    //is accessible for an installation by a user. stupid.
    let repositories: GitHubRepositoryData[];
    try {
      repositories = await this.listUserAccessibleInstallationRepos(
        userId,
        userAccessToken,
        installationId,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return failure({
          code: "INSTALLATION_NOT_FOUND",
          message: `No GitHub App installation found for installation ${installationId}.`,
        });
      }

      if (this.isUserAuthenticationFailure(error)) {
        return failure({
          code: "GITHUB_AUTH_ERROR",
          message: "GitHub user authentication is no longer valid.",
        });
      }

      return this.githubApiFailure(
        `Failed to list accessible repositories for installation ${installationId}.`,
        error,
      );
    }

    const matchingRepository = repositories.find((repo) => repo.id === repoId);

    if (!matchingRepository) {
      await this.userRepoAccessCacheRepository.setDenied(
        userId,
        installationId,
        repoId,
        this.buildUserRepoAccessCacheExpiry(),
      );
      return failure({
        code: "REPO_NOT_ACCESSIBLE",
        message: `Repository ${repoId} is not accessible to the authenticated user`,
      });
    }

    return success(matchingRepository);
  }

  /**
   * Find the GitHub App installation for a given repo by its owner and name.
   * NOTE: Prefer to use findInstallationForRepoId instead. it is more efficient and canonical.
   * First checks D1, then falls back to the GitHub API.
   */
  private async findInstallationForRepo(
    owner: string,
    repo: string,
  ): Promise<GitHubAppResult<GitHubInstallationWithRepo>> {
    // Check D1 first
    const installation = await this.installationRepository.findByAccountLogin(owner);

    // if access is "selected", the repo should be stored in the db.
    // if access is "all", we need to verify that the repo actually exists via api.
    if (installation && installation.repositorySelection === "selected") {
      const installationRepo = await this.installationRepository.findRepo(
        installation.id,
        `${owner}/${repo}`, // use full name
      );

      if (!installationRepo) {
        return failure({
          code: "REPO_NOT_ACCESSIBLE",
          message: `Repository ${owner}/${repo} is not accessible via the GitHub App installation`,
        });
      }
      return success(installation);
    }

    // Fallback: query GitHub API directly
    try {
      const { data } = await this.app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });

      return success({
        id: data.id,
        repositorySelection: (data.repository_selection ?? "all") as RepositorySelection,
      });
    } catch (error) {
      this.logger.error("Failed to get repository installation", { fields: { owner, repo }, error });

      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return failure({
          code: "INSTALLATION_NOT_FOUND",
          message: `No GitHub App installation found for ${owner}/${repo}. Is the app installed on this account?`,
        });
      }

      return this.githubApiFailure(
        `Failed to get repository installation for ${owner}/${repo}.`,
        error,
      );
    }
  }

  /**
   * Find the GitHub App installation for a repo using its numeric GitHub ID.
   */
  async findInstallationForRepoId(
    repoId: number,
    userAccessToken: string,
  ): Promise<GitHubAppResult<GitHubInstallationWithRepo>> {
    // first check d1
    const installation = await this.installationRepository.findByRepoId(repoId);

    if (installation) {
      return success(installation);
    }

    try {
      const userOctokit = new Octokit({ auth: userAccessToken });
      const response = await userOctokit.request("GET /repositories/{repository_id}", {
        repository_id: repoId,
      });
      const repoData = response.data;
      const owner = repoData.owner.login;
      const repo = repoData.name;

      return this.findInstallationForRepo(owner, repo);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        this.logger.warn("Received 404 from GitHub API for repo", { fields: { repoId } });
        return failure({
          code: "REPO_NOT_ACCESSIBLE",
          message: `Repository ${repoId} is not accessible to the authenticated user.`,
        });
      }

      if (this.isUserAuthenticationFailure(error)) {
        return failure({
          code: "GITHUB_AUTH_ERROR",
          message: "GitHub user authentication is no longer valid.",
        });
      }

      return this.githubApiFailure(
        `Failed to resolve repository ${repoId} from GitHub.`,
        error,
      );
    }
  }

  private parseRepoFullName(repoFullName: string): GitHubAppResult<{
    owner: string;
    repo: string;
  }> {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      return failure({
        code: "INVALID_REPO",
        message: `Invalid repoFullName: ${repoFullName}`,
      });
    }

    return success({ owner, repo });
  }

  private githubApiFailure<T>(
    message: string,
    error: unknown,
  ): GitHubAppResult<T> {
    const details = formatGitHubErrorDetails(error);
    this.logger.error("GitHub API failure", { fields: { message, details: details ?? null }, error });
    return failure({
      code: "GITHUB_API_ERROR",
      message,
      details,
    });
  }

  private isPullRequestValidationError(error: unknown): boolean {
    return isRecord(error) && error.status === 422;
  }

  /**
   * Get an installation access token, using D1 cache with 5-minute buffer.
   * This token allows to make requests as the app on the installation.
   */
  async getInstallationToken(
    installationId: number,
    repo?: { repoName: string; repoId: number },
    permissions: { contents: "read" | "write"; metadata: "read" } = { contents: "write", metadata: "read" },
  ): Promise<string> {
    // Cache key includes installation, repo, and permission scope to avoid cross-token leaks
    const cacheRepoId = repo?.repoId ?? 0;
    const permissionSuffix = permissions.contents === "read" ? ":ro" : "";
    const cacheKey = `${cacheRepoId}${permissionSuffix}`;
    const cached = await this.tokenCacheRepository.get(installationId, cacheKey);

    if (cached) {
      try {
        return await decrypt(cached.token, this.tokenEncryptionKey);
      } catch {
        // Legacy rows may still contain plaintext values from before encryption.
        return cached.token;
      }
    }

    // Generate new token via octokit, scoped to single repo with requested permissions
    const octokit = await this.app.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
      ...(repo && { repositories: [repo.repoName] }),
      permissions,
    });

    // Cache it
    const encryptedToken = await encrypt(data.token, this.tokenEncryptionKey);
    await this.tokenCacheRepository.set(installationId, cacheKey, encryptedToken, data.expires_at);

    return data.token;
  }

}

function getNextPageCursor(linkHeader?: string): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const segment of linkHeader.split(",")) {
    if (!segment.includes('rel="next"')) {
      continue;
    }

    const nextPageMatch = segment.match(/[?&]page=(\d+)/);
    return nextPageMatch?.[1] ?? null;
  }

  return null;
}

function decodeBase64Text(content: string): string {
  const binary = atob(content.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function isHttpStatus(error: unknown, status: number): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && error.status === status;
}
