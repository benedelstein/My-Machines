import { z } from "zod";

export const AuthMethod = z.enum(["oauth"]);
export type AuthMethod = z.infer<typeof AuthMethod>;

// --- Claude ----------------------------------------------------------------

export const CLAUDE_PROVIDER_ID = "claude-code" as const;

export const ClaudeModel = z.enum([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);
export type ClaudeModel = z.infer<typeof ClaudeModel>;

export const ClaudeEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ClaudeEffort = z.infer<typeof ClaudeEffort>;

export const AgentSettingsClaude = z.object({
  provider: z.literal(CLAUDE_PROVIDER_ID),
  model: ClaudeModel.default("claude-fable-5"),
  effort: ClaudeEffort.default("high"),
  maxTokens: z.number().int().default(8192),
});

// --- OpenAI Codex ------------------------------------------------------------

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;

export const OpenAICodexModel = z.enum([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  // "gpt-5.1-codex-max",
  "gpt-5.2",
]);
export type OpenAICodexModel = z.infer<typeof OpenAICodexModel>;

export const OpenAICodexEffort = z.enum(["low", "medium", "high", "xhigh"]);
export type OpenAICodexEffort = z.infer<typeof OpenAICodexEffort>;

export const AgentSettingsCodex = z.object({
  provider: z.literal(OPENAI_CODEX_PROVIDER_ID),
  model: OpenAICodexModel.default("gpt-5.6-sol"),
  effort: OpenAICodexEffort.default("high"),
  maxTokens: z.number().int().default(8192),
});

// --- Provider selection --------------------------------------------------------

export const ProviderId = z.enum([CLAUDE_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID]);
export type ProviderId = z.infer<typeof ProviderId>;

export const AgentSettings = z.discriminatedUnion("provider", [
  AgentSettingsCodex,
  AgentSettingsClaude,
]);
export type AgentSettings = z.infer<typeof AgentSettings>;

export const DEFAULT_PROVIDER_ID = CLAUDE_PROVIDER_ID;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = AgentSettings.parse({ provider: DEFAULT_PROVIDER_ID });

// Compile-time check: every ProviderId must have a corresponding AgentSettings variant.
// Adding a new ProviderId without a matching AgentSettings entry will cause a type error here.
export declare const _agentSettingsExhaustiveCheck: [AgentSettings["provider"]] extends [ProviderId]
  ? [ProviderId] extends [AgentSettings["provider"]]
    ? true
    : never
  : never;
