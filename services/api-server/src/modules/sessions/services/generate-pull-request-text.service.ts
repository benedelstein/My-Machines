import { createAnthropic } from "@ai-sdk/anthropic";
import { dedent } from "@repo/shared";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLogger } from "@/shared/logging";

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 6000;
const MAX_FILES = 30;
const MAX_COMMITS = 20;
const MAX_COMMIT_MESSAGE_CHARS = 120;
const MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 280;

const PULL_REQUEST_TEXT_SYSTEM_PROMPT = dedent`
  You write concise GitHub pull request text from a code diff summary.
  Rules:
  - title: specific, imperative mood, no trailing period, <= 72 characters.
  - body: lightweight markdown summary, concise and actionable.
  - body should mention key file groups and user-visible behavior changes.
  - include testing notes only if data is explicitly present.
`;

const pullRequestTextSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  body: z.string().min(1).max(MAX_BODY_CHARS),
});

const logger = createLogger("generate-pull-request-text.service.ts");

export interface PullRequestDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PullRequestDiffCommit {
  sha: string;
  message: string;
  authorName: string | null;
}

export interface PullRequestTextContext {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  aheadBy: number;
  totalCommits: number;
  files: PullRequestDiffFile[];
  commits: PullRequestDiffCommit[];
  recentMessages: string[];
}

export interface PullRequestText {
  title: string;
  body: string;
}

function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?;:]+$/g, "")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function isValidTitle(title: string): boolean {
  if (!title) {
    return false;
  }

  if (title.length > MAX_TITLE_CHARS) {
    return false;
  }

  if (title.includes("\n")) {
    return false;
  }

  return true;
}

export function fallbackPullRequestTitle(
  headBranch: string,
  files: PullRequestDiffFile[] = [],
): string {
  const firstFile = files.find((file) => file.filename.trim().length > 0);
  if (firstFile) {
    const filename = firstFile.filename.split("/").pop() ?? firstFile.filename;
    return normalizeTitle(`Update ${filename}`);
  }

  const titleSlug = headBranch
    .replace(/^cloude\//, "")
    .replace(/^mymachines\//, "")
    .replace(/-[a-z0-9]{4}$/, "")
    .replace(/[-_/]/g, " ");
  const normalized = normalizeTitle(titleSlug);
  if (!normalized) {
    return "Update project files";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildPrompt(context: PullRequestTextContext): string {
  const files = context.files
    .slice(0, MAX_FILES)
    .map((file) => {
      const stats = `+${file.additions}/-${file.deletions}`;
      return `- ${file.filename} (${file.status}, ${stats})`;
    })
    .join("\n");

  const commits = context.commits
    .slice(0, MAX_COMMITS)
    .map((commit) => {
      const shortSha = commit.sha.slice(0, 7);
      const message = commit.message.replace(/\s+/g, " ").trim().slice(0, MAX_COMMIT_MESSAGE_CHARS);
      const author = commit.authorName ? ` by ${commit.authorName}` : "";
      return `- ${shortSha}: ${message}${author}`;
    })
    .join("\n");

  const messages = context.recentMessages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => message.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((message) => `- ${message.slice(0, MAX_CONTEXT_CHARS)}`)
    .join("\n");

  return dedent`
    Repository: ${context.repoFullName}
    Base branch: ${context.baseBranch}
    Head branch: ${context.headBranch}
    Commits ahead: ${context.aheadBy}
    Total commits in compare: ${context.totalCommits}

    Changed files:
    ${files || "- (none provided)"}

    Recent commits:
    ${commits || "- (none provided)"}

    Recent session messages:
    ${messages || "- (none provided)"}
  `;
}

/**
 * Generate PR title/body from diff context. Returns null if generation fails.
 */
export async function generatePullRequestText(
  anthropicApiKey: string,
  context: PullRequestTextContext,
): Promise<PullRequestText | null> {
  try {
    const anthropic = createAnthropic({ apiKey: anthropicApiKey });
    const prompt = buildPrompt(context);
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      output: Output.object({ schema: pullRequestTextSchema }),
      maxOutputTokens: 700,
      system: PULL_REQUEST_TEXT_SYSTEM_PROMPT,
      prompt,
    });

    const title = normalizeTitle(result.output.title);
    if (!isValidTitle(title)) {
      return null;
    }

    return { title, body: result.output.body };
  } catch (error) {
    logger.error("Failed to generate pull request text via LLM", { error });
    return null;
  }
}
