import { createAnthropic } from "@ai-sdk/anthropic";
import {
  type CreateSessionRequest,
  type IntegrationExternalUser,
  type IntegrationLinkClaimResponse,
  type IntegrationLinksResponse,
  type IntegrationProvider,
  type IntegrationRepoCandidate,
  type IntegrationSessionRequest,
  type IntegrationSessionResponse,
  type Repo,
  dedent,
  encodeBase64Url,
  failure,
  type Result,
  success,
} from "@repo/shared";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLogger } from "@/shared/logging";
import type { Env } from "@/shared/types";
import { sha256 } from "@/shared/utils/crypto";
import { IntegrationAccountLinkRepository } from "../repositories/integration-account-link.repository";
import { IntegrationLinkAttemptRepository } from "../repositories/integration-link-attempt.repository";
import type {
  IntegrationLinkClaimerError,
  IntegrationRepoResolution,
  IntegrationRepoRoutingCandidate,
  IntegrationSessionRequestDeps,
} from "../types/integrations.types";
import { findDirectRepoReference, rankRepos } from "../utils/repo-routing.utils";

const logger = createLogger("integration-session-request.service.ts");
const MAX_REPOS_TO_ROUTE = 300;
const MAX_ROUTING_CANDIDATES = 20;
const MAX_README_CANDIDATES = 8;
const MAX_README_CHARS = 1800;
const MIN_LLM_CONFIDENCE = 0.55;
const MIN_HEURISTIC_SCORE = 8;
const LINK_ATTEMPT_TTL_MS = 15 * 60 * 1000;
const ACCOUNT_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LINK_TOKEN_BYTES = 32;

export interface IntegrationSessionRequestStores {
  accountLinks: Pick<
    IntegrationAccountLinkRepository,
    "getActive" | "listActiveByUserId" | "revokeByUserAndProvider" | "touchLastUsed" | "upsert"
  >;
  linkAttempts: Pick<
    IntegrationLinkAttemptRepository,
    "consumeValid" | "create" | "deleteForExternalUser"
  >;
}

// Anthropic structured output rejects numeric minimum/maximum and string
// maxLength schema keywords, so express the bounds in descriptions instead.
const repoRoutingSchema = z.object({
  selectedRepoId: z.number().nullable(),
  confidence: z.number().describe("Between 0 and 1."),
  reason: z.string().optional().describe("At most 200 characters."),
});

const REPO_ROUTER_SYSTEM_PROMPT = dedent`
  You route an external integration request to exactly one GitHub repository.
  Choose from the provided candidates only.
  Use repository names, owner/name, descriptions, and README excerpts.
  If the request names a repo alias, prefer the repository whose name best matches that alias.
  Return null when no candidate is a plausible match or when multiple candidates are equally plausible.
`;

export class IntegrationSessionRequestService {
  private readonly env: Env;
  private readonly deps: IntegrationSessionRequestDeps;
  private readonly accountLinkRepository: IntegrationSessionRequestStores["accountLinks"];
  private readonly linkAttemptRepository: IntegrationSessionRequestStores["linkAttempts"];

  constructor(
    env: Env,
    deps: IntegrationSessionRequestDeps,
    stores?: IntegrationSessionRequestStores,
  ) {
    this.env = env;
    this.deps = deps;
    this.accountLinkRepository = stores?.accountLinks
      ?? new IntegrationAccountLinkRepository(env.DB);
    this.linkAttemptRepository = stores?.linkAttempts
      ?? new IntegrationLinkAttemptRepository(env.DB);
  }

  /**
   * Resolves the external integration user, routes the prompt to a repository,
   * and creates a My Machines session with the prompt as the initial user message.
   */
  async createSessionFromIntegration(params: {
    request: IntegrationSessionRequest;
    executionCtx: ExecutionContext;
  }): Promise<IntegrationSessionResponse> {
    const { externalUser } = params.request;
    const externalUsername = getExternalUsername(externalUser);
    const link = await this.accountLinkRepository.getActive({
      provider: externalUser.provider,
      externalUserId: externalUser.id,
    });
    if (!link) {
      return this.createLinkRequiredResponse(params.request);
    }

    await this.accountLinkRepository.touchLastUsed({
      provider: externalUser.provider,
      externalUserId: externalUser.id,
      externalUsername,
    });

    const githubAccessToken = await this.deps.tokenProvider.getValidGitHubAccessTokenByUserId(link.userId);
    if (!githubAccessToken) {
      return {
        ok: false,
        code: "GITHUB_AUTH_REQUIRED",
        message: "The linked My Machines account needs to sign in with GitHub again.",
      };
    }

    const reposResult = await this.deps.repoCandidateProvider.listAccessibleRepos({
      userId: link.userId,
      githubAccessToken,
      executionCtx: params.executionCtx,
      limit: MAX_REPOS_TO_ROUTE,
    });
    if (!reposResult.ok) {
      logger.warn("Failed to list repos for integration request", {
        fields: { provider: externalUser.provider, userId: link.userId },
      });
      return {
        ok: false,
        code: "REPO_LISTING_FAILED",
        message: "I could not load the linked account's repositories. Try again shortly.",
      };
    }

    const resolution = await this.resolveRepository({
      prompt: params.request.prompt,
      repos: reposResult.value,
      githubAccessToken,
    });
    if (!resolution) {
      const ranked = rankRepos(params.request.prompt, reposResult.value)
        .slice(0, 5)
        .map(toIntegrationRepoCandidate);
      if (ranked.length > 0) {
        return {
          ok: false,
          code: "AMBIGUOUS_REPO_MATCH",
          message: "I could not confidently choose a repository. Include owner/repo or the exact repo name.",
          candidates: ranked,
        };
      }
      // Nothing scored: suggest the first few accessible repos so the reply
      // still tells them what repo hints would work.
      return {
        ok: false,
        code: "NO_REPO_MATCH",
        message: "I could not find a repository match for that request. Include owner/repo or the exact repo name.",
        candidates: reposResult.value
          .slice(0, 5)
          .map((repo) => toIntegrationRepoCandidate({ ...repo, score: 0 })),
      };
    }

    const environmentId = await this.resolveDefaultEnvironmentId({
      userId: link.userId,
      repoId: resolution.repo.id,
    });
    const sessionResult = await this.deps.sessionCreator.createSession({
      userId: link.userId,
      githubAccessToken,
      request: this.buildCreateSessionRequest(params.request, resolution.repo, environmentId),
      source: externalUser.provider,
    });
    if (!sessionResult.ok) {
      return {
        ok: false,
        code: "SESSION_CREATE_FAILED",
        message: sessionResult.error.message,
      };
    }

    logger.info("Created session from integration request", {
      fields: {
        provider: externalUser.provider,
        userId: link.userId,
        sessionId: sessionResult.value.sessionId,
        repoId: resolution.repo.id,
      },
    });

    return {
      ok: true,
      sessionId: sessionResult.value.sessionId,
      title: sessionResult.value.title,
      repoId: resolution.repo.id,
      repoFullName: resolution.repo.fullName,
      sessionUrl: this.buildSessionUrl(sessionResult.value.sessionId),
      routingReason: resolution.reason,
    };
  }

  async listIntegrationLinks(params: { userId: string }): Promise<IntegrationLinksResponse> {
    const links = await this.accountLinkRepository.listActiveByUserId(params.userId);
    return {
      links: links.map((link) => ({
        provider: link.provider,
        externalUserId: link.externalUserId,
        externalUsername: link.externalUsername,
        expiresAt: link.expiresAt,
        lastUsedAt: link.lastUsedAt,
      })),
    };
  }

  async revokeIntegrationLink(params: {
    userId: string;
    provider: IntegrationProvider;
  }): Promise<void> {
    await this.accountLinkRepository.revokeByUserAndProvider(params);
    logger.info("Revoked integration account link", {
      fields: { provider: params.provider, userId: params.userId },
    });
  }

  async claimIntegrationLink(params: {
    token: string;
    userId: string;
  }): Promise<Result<IntegrationLinkClaimResponse, IntegrationLinkClaimerError>> {
    const tokenHash = await sha256(params.token);
    const attempt = await this.linkAttemptRepository.consumeValid({
      tokenHash,
      claimedUserId: params.userId,
    });
    if (!attempt) {
      return failure({
        status: 400,
        message: "This integration link is invalid or expired. Request a new link from your integration.",
      });
    }

    const linkExpiresAt = new Date(Date.now() + ACCOUNT_LINK_TTL_MS).toISOString();
    await this.accountLinkRepository.upsert({
      provider: attempt.provider,
      externalUserId: attempt.externalUserId,
      userId: params.userId,
      externalUsername: attempt.externalUsername,
      expiresAt: linkExpiresAt,
    });

    logger.info("Claimed integration account link", {
      fields: {
        provider: attempt.provider,
        externalUserId: attempt.externalUserId,
        userId: params.userId,
      },
    });

    return success({
      ok: true,
      provider: attempt.provider,
      externalUserId: attempt.externalUserId,
      externalUsername: attempt.externalUsername,
      expiresAt: linkExpiresAt,
    });
  }

  private async createLinkRequiredResponse(
    request: IntegrationSessionRequest,
  ): Promise<IntegrationSessionResponse> {
    const token = createLinkToken();
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + LINK_ATTEMPT_TTL_MS).toISOString();

    // Only the newest attempt per external user stays valid, which also bounds table growth.
    await this.linkAttemptRepository.deleteForExternalUser({
      provider: request.externalUser.provider,
      externalUserId: request.externalUser.id,
    });
    await this.linkAttemptRepository.create({
      tokenHash,
      provider: request.externalUser.provider,
      externalUserId: request.externalUser.id,
      externalUsername: getExternalUsername(request.externalUser),
      expiresAt,
    });

    logger.info("Created integration link attempt", {
      fields: {
        provider: request.externalUser.provider,
        externalUserId: request.externalUser.id,
      },
    });

    return {
      ok: false,
      code: "EXTERNAL_USER_NOT_LINKED",
      message: "Link or reconnect your My Machines account to use My Machines from this integration.",
      linkUrl: this.buildIntegrationLinkUrl(token, request.externalUser.provider),
      linkExpiresAt: expiresAt,
    };
  }

  private buildCreateSessionRequest(
    request: IntegrationSessionRequest,
    repo: IntegrationRepoRoutingCandidate,
    environmentId: string | null,
  ): CreateSessionRequest {
    const externalUsername = getExternalUsername(request.externalUser);
    const prefix = externalUsername
      ? `${formatProviderName(request.externalUser.provider)} request from ${externalUsername}:`
      : `${formatProviderName(request.externalUser.provider)} request:`;
    return {
      repoId: repo.id,
      initialMessage: {
        content: `${prefix}\n\n${request.prompt}`,
      },
      environmentId: environmentId ?? undefined,
    };
  }

  // Mirrors the web client, which preselects the repo's most recently updated
  // environment. Best-effort: a session without an environment beats no session.
  private async resolveDefaultEnvironmentId(params: {
    userId: string;
    repoId: number;
  }): Promise<string | null> {
    try {
      return await this.deps.environmentProvider.getDefaultEnvironmentId(params);
    } catch (error) {
      logger.warn("Failed to resolve default environment for integration session", {
        fields: {
          userId: params.userId,
          repoId: params.repoId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  private buildSessionUrl(sessionId: string): string | undefined {
    const origin = this.env.WEB_ORIGIN?.replace(/\/$/, "");
    return origin ? `${origin}/session/${sessionId}` : undefined;
  }

  private buildIntegrationLinkUrl(token: string, provider: IntegrationProvider): string {
    const origin = this.env.WEB_ORIGIN.replace(/\/$/, "");
    const path = provider === "discord" ? "/discord/link" : "/integrations/link";
    const url = new URL(path, origin);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private async resolveRepository(params: {
    prompt: string;
    repos: Repo[];
    githubAccessToken: string;
  }): Promise<IntegrationRepoResolution | null> {
    const directMatch = findDirectRepoReference(params.prompt, params.repos);
    if (directMatch) {
      return {
        repo: { ...directMatch, score: Number.MAX_SAFE_INTEGER },
        reason: "Matched explicit repository name.",
      };
    }

    const candidates = rankRepos(params.prompt, params.repos)
      .slice(0, MAX_ROUTING_CANDIDATES);
    if (candidates.length === 0) {
      return null;
    }

    const enrichedCandidates = await this.addReadmeExcerpts({
      candidates,
      githubAccessToken: params.githubAccessToken,
    });
    const llmResolution = await this.resolveRepositoryWithLlm({
      prompt: params.prompt,
      candidates: enrichedCandidates,
    });
    if (llmResolution) {
      return llmResolution;
    }

    const [first, second] = candidates;
    if (first && first.score >= MIN_HEURISTIC_SCORE && (!second || first.score > second.score * 1.8)) {
      return {
        repo: first,
        reason: "Matched repository name and description keywords.",
      };
    }

    return null;
  }

  private async addReadmeExcerpts(params: {
    candidates: IntegrationRepoRoutingCandidate[];
    githubAccessToken: string;
  }): Promise<IntegrationRepoRoutingCandidate[]> {
    const enriched = [...params.candidates];
    const readmeCandidates = enriched.slice(0, MAX_README_CANDIDATES);
    const readmes = await Promise.all(readmeCandidates.map((repo) =>
      this.deps.repoCandidateProvider.getReadme({
        githubAccessToken: params.githubAccessToken,
        repo,
      }),
    ));

    for (let index = 0; index < readmes.length; index += 1) {
      const excerpt = toReadmeExcerpt(readmes[index] ?? null);
      if (excerpt) {
        enriched[index] = { ...enriched[index]!, readmeExcerpt: excerpt };
      }
    }
    return enriched;
  }

  private async resolveRepositoryWithLlm(params: {
    prompt: string;
    candidates: IntegrationRepoRoutingCandidate[];
  }): Promise<IntegrationRepoResolution | null> {
    try {
      const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const result = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        output: Output.object({ schema: repoRoutingSchema }),
        maxOutputTokens: 180,
        system: REPO_ROUTER_SYSTEM_PROMPT,
        prompt: buildRoutingPrompt(params.prompt, params.candidates),
      });
      const selectedRepoId = result.output.selectedRepoId;
      if (!selectedRepoId || result.output.confidence < MIN_LLM_CONFIDENCE) {
        return null;
      }

      const repo = params.candidates.find((candidate) => candidate.id === selectedRepoId);
      if (!repo) {
        return null;
      }

      return {
        repo,
        reason: result.output.reason,
      };
    } catch (error) {
      logger.warn("Failed to route integration request via LLM", { error });
      return null;
    }
  }
}

function buildRoutingPrompt(
  prompt: string,
  candidates: IntegrationRepoRoutingCandidate[],
): string {
  const candidateText = candidates.map((candidate) => dedent`
    - repoId: ${candidate.id}
      fullName: ${candidate.fullName}
      description: ${candidate.description ?? ""}
      heuristicScore: ${candidate.score}
      readmeExcerpt: ${candidate.readmeExcerpt ?? ""}
  `).join("\n");

  return dedent`
    User request:
    ${prompt}

    Candidate repositories:
    ${candidateText}
  `;
}

function createLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_TOKEN_BYTES));
  return encodeBase64Url(bytes);
}

function getExternalUsername(externalUser: IntegrationExternalUser): string | null {
  switch (externalUser.provider) {
    case "discord":
      return externalUser.displayName ?? externalUser.username ?? null;
    case "slack":
    case "generic":
      return externalUser.displayName ?? null;
    default: {
      const exhaustiveCheck: never = externalUser;
      throw new Error(`Unhandled integration user: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function formatProviderName(provider: IntegrationProvider): string {
  switch (provider) {
    case "discord":
      return "Discord";
    case "slack":
      return "Slack";
    case "generic":
      return "External integration";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unhandled integration provider: ${exhaustiveCheck}`);
    }
  }
}

function toReadmeExcerpt(readme: string | null): string | null {
  if (!readme) {
    return null;
  }
  const flattened = readme.replace(/\s+/g, " ").trim();
  return flattened ? flattened.slice(0, MAX_README_CHARS) : null;
}

function toIntegrationRepoCandidate(repo: IntegrationRepoRoutingCandidate): IntegrationRepoCandidate {
  return {
    repoId: repo.id,
    repoFullName: repo.fullName,
    reason: repo.description ?? undefined,
  };
}
