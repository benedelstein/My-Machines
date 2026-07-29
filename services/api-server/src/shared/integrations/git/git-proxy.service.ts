import type { Logger } from "@repo/shared";
import type {
  GitProxyRepoPolicyProvider,
  GitProxySecretProvider,
  GitProxyTokenProvider,
} from "./git.providers";

export interface GitProxyServiceDeps {
  tokenProvider: GitProxyTokenProvider;
  secretProvider: GitProxySecretProvider;
  repoPolicyProvider: GitProxyRepoPolicyProvider;
  logger: Logger;
}

export interface GitProxyResult {
  response: Response;
  pushedBranch: string | null;
}

// HTTP Basic requires a realm. This stable value names the Worker git-proxy
// protection space; it is not a credential or an upstream GitHub identifier.
const GIT_PROXY_BASIC_REALM = "my-machines-git-proxy";

export class GitProxyService {
  private readonly tokenProvider: GitProxyTokenProvider;
  private readonly secretProvider: GitProxySecretProvider;
  private readonly repoPolicyProvider: GitProxyRepoPolicyProvider;
  private readonly logger: Logger;

  constructor(deps: GitProxyServiceDeps) {
    this.tokenProvider = deps.tokenProvider;
    this.secretProvider = deps.secretProvider;
    this.repoPolicyProvider = deps.repoPolicyProvider;
    this.logger = deps.logger.scope("git-proxy");
  }

  async handleRequest(request: Request, path: string): Promise<GitProxyResult> {
    this.logger.debug("[git-proxy] request", {
      fields: { method: request.method, url: request.url },
    });

    const authHeader = request.headers.get("Authorization");
    if (!this.secretProvider.authenticateGitRequest(authHeader)) {
      this.logger.warn("[git-proxy] auth failed", {
        fields: {
          hasAuthorizationHeader: authHeader !== null,
        },
      });
      return this.result("unauthorized", 401, {
        "WWW-Authenticate": `Basic realm="${GIT_PROXY_BASIC_REALM}"`,
      });
    }

    const githubPath = this.parseGitHubPath(path);
    if (!githubPath) {
      return this.result("invalid path", 400);
    }

    const repoFullName = this.repoPolicyProvider.getAllowedRepoFullName();
    if (!repoFullName) {
      this.logger.warn("[git-proxy] repo not configured");
      return this.result("repo not configured", 409);
    }

    if (!githubPath.startsWith(`${repoFullName}.git`)) {
      this.logger.warn("[git-proxy] repo not allowed", {
        fields: { githubPath, repoFullName },
      });
      return this.result("repo not allowed", 403);
    }

    if (githubPath.endsWith("/git-receive-pack") && request.method === "POST") {
      const body = await request.arrayBuffer();
      const pushCheck = validatePush(
        new Uint8Array(body),
        this.repoPolicyProvider.getSessionId(),
        this.repoPolicyProvider.getPushedBranch(),
      );
      if (!pushCheck.allowed) {
        this.logger.warn("[git-proxy] push rejected", {
          fields: { reason: pushCheck.reason ?? "unknown" },
        });
        return this.result(`push rejected: ${pushCheck.reason}`, 403);
      }

      const result = await this.forwardToGitHub(githubPath, request, body, repoFullName);
      if (result.response.ok && pushCheck.branch) {
        result.pushedBranch = pushCheck.branch;
      }
      return result;
    }

    return this.forwardToGitHub(githubPath, request, request.body, repoFullName);
  }

  private parseGitHubPath(path: string): string | null {
    const match = path.match(/^\/git-proxy\/[^/]+\/github\.com\/(.+)/);
    return match?.[1] ?? null;
  }

  private async forwardToGitHub(
    githubPath: string,
    originalRequest: Request,
    body: ArrayBuffer | ReadableStream<Uint8Array> | null,
    repoFullName: string,
  ): Promise<GitProxyResult> {
    this.logger.debug("[git-proxy] forwarding to GitHub", {
      fields: { githubPath },
    });

    const tokenResult = await this.tokenProvider.getInstallationTokenForRepo(repoFullName);
    if (!tokenResult.ok) {
      this.logger.warn("[git-proxy] installation token unavailable", {
        fields: {
          code: tokenResult.error.code,
          status: tokenResult.error.status,
          repoFullName,
        },
      });
      return this.result(tokenResult.error.message, tokenResult.error.status);
    }

    const url = new URL(originalRequest.url);
    const targetUrl = `https://github.com/${githubPath}${url.search}`;
    const basicAuth = btoa(`x-access-token:${tokenResult.value}`);
    const headers: Record<string, string> = {
      "User-Agent": "cloude-code-git-proxy",
      "Authorization": `Basic ${basicAuth}`,
    };

    const contentType = originalRequest.headers.get("Content-Type");
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    try {
      const response = await globalThis.fetch(targetUrl, {
        method: originalRequest.method,
        headers,
        body,
      });

      this.logger.debug("[git-proxy] GitHub response", {
        fields: {
          status: response.status,
          method: originalRequest.method,
          githubPath,
        },
      });
      return { response, pushedBranch: null };
    } catch (error) {
      this.logger.error("[git-proxy] GitHub fetch failed", {
        error,
        fields: { method: originalRequest.method, githubPath },
      });
      return this.result("GitHub request failed", 502);
    }
  }

  private result(
    message: string,
    status: number,
    headers?: HeadersInit,
  ): GitProxyResult {
    return {
      response: new Response(message, { status, headers }),
      pushedBranch: null,
    };
  }
}

function validatePush(
  body: Uint8Array,
  sessionId: string | null,
  lockedBranch: string | null,
): { allowed: boolean; reason?: string; branch?: string } {
  const sessionSuffix = sessionId ? sessionId.slice(0, 4) : null;

  // Git pkt-line format: "oldsha newsha refs/heads/branch\0capabilities..."
  const preamble = new TextDecoder().decode(body.slice(0, 2048));
  const refPattern = /[0-9a-f]{40} [0-9a-f]{40} refs\/heads\/([^\s\0]+)/g;
  let match;
  let detectedBranch: string | undefined;
  while ((match = refPattern.exec(preamble)) !== null) {
    const branch = match[1]!;
    if (!branch.startsWith("cloude/")) {
      return { allowed: false, reason: `branch must start with 'cloude/', got '${branch}'` };
    }
    if (sessionSuffix && !branch.endsWith(sessionSuffix)) {
      return { allowed: false, reason: `branch must end with '${sessionSuffix}', got '${branch}'` };
    }
    // Enforce branch lock: subsequent pushes must target the same branch
    if (lockedBranch && branch !== lockedBranch) {
      return { allowed: false, reason: `branch locked to '${lockedBranch}', got '${branch}'` };
    }
    detectedBranch = branch;
  }
  return { allowed: true, branch: detectedBranch };
}
