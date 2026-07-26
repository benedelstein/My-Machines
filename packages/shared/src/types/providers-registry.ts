import {
  CLAUDE_PROVIDER_ID,
  ClaudeEffort,
  ClaudeModel,
  OPENAI_CODEX_PROVIDER_ID,
  OpenAICodexEffort,
} from "@repo/api-contract";
import type { AuthMethod, OpenAICodexModel, ProviderId } from "@repo/api-contract";

/**
 * Server-side provider catalog: definitions, display names, and lookup
 * helpers. The client-facing projection of this registry is ModelsResponse
 * (@repo/api-contract); clients never consume these shapes directly.
 */

export type ProviderModelId = string;

export type ProviderModelDefinition<ModelId extends ProviderModelId = ProviderModelId> = {
  id: ModelId;
  displayName: string;
  isDefault: boolean;
};

export type ProviderEffortId = string;

export type ProviderEffortDefinition<EffortId extends ProviderEffortId = ProviderEffortId> = {
  id: EffortId;
  displayName: string;
  isDefault: boolean;
};

export type ProviderDefinition<
  Id extends string = string,
  ModelId extends ProviderModelId = ProviderModelId,
  EffortId extends ProviderEffortId = ProviderEffortId,
> = {
  id: Id;
  displayName: string;
  defaultModel: ModelId;
  defaultEffort: EffortId;
  authMethods: AuthMethod[];
  models: ProviderModelDefinition<ModelId>[];
  efforts: ProviderEffortDefinition<EffortId>[];
  todoToolName: string;
};

// --- Claude -----------------------------------------------------------------

export const CLAUDE_MODEL_DISPLAY_NAMES: Record<ClaudeModel, string> = {
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

export const CLAUDE_EFFORT_DISPLAY_NAMES: Record<ClaudeEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const CLAUDE_MODELS: ProviderModelDefinition<ClaudeModel>[] = ClaudeModel.options.map((id) => ({
  id,
  displayName: CLAUDE_MODEL_DISPLAY_NAMES[id],
  isDefault: id === "claude-fable-5",
}));

const CLAUDE_EFFORTS: ProviderEffortDefinition<ClaudeEffort>[] = ClaudeEffort.options.map((id) => ({
  id,
  displayName: CLAUDE_EFFORT_DISPLAY_NAMES[id],
  isDefault: id === "high",
}));

export const CLAUDE_PROVIDER: ProviderDefinition<typeof CLAUDE_PROVIDER_ID, ClaudeModel, ClaudeEffort> = {
  id: CLAUDE_PROVIDER_ID,
  displayName: "Claude Code",
  defaultModel: "claude-fable-5",
  defaultEffort: "high",
  authMethods: ["oauth"],
  todoToolName: "TaskCreate",
  models: CLAUDE_MODELS,
  efforts: CLAUDE_EFFORTS,
};

// --- OpenAI Codex -------------------------------------------------------------

export const OPENAI_CODEX_MODEL_DISPLAY_NAMES: Record<OpenAICodexModel, string> = {
  "gpt-5.6-sol": "5.6 Sol",
  "gpt-5.6-terra": "5.6 Terra",
  "gpt-5.6-luna": "5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.2": "GPT-5.2",
};

export const OPENAI_CODEX_EFFORT_DISPLAY_NAMES: Record<OpenAICodexEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const OPENAI_CODEX_MODELS: ProviderModelDefinition<OpenAICodexModel>[] = [
  {
    id: "gpt-5.6-sol",
    displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.6-sol"],
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.6-terra"],
    isDefault: false,
  },
  {
    id: "gpt-5.6-luna",
    displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.6-luna"],
    isDefault: false,
  },
  { id: "gpt-5.5", displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.5"], isDefault: false },
  { id: "gpt-5.4", displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.4"], isDefault: false },
  {
    id: "gpt-5.4-mini",
    displayName: OPENAI_CODEX_MODEL_DISPLAY_NAMES["gpt-5.4-mini"],
    isDefault: false,
  },
];

const OPENAI_CODEX_EFFORTS: ProviderEffortDefinition<OpenAICodexEffort>[] =
  OpenAICodexEffort.options.map((id) => ({
    id,
    displayName: OPENAI_CODEX_EFFORT_DISPLAY_NAMES[id],
    isDefault: id === "high",
  }));

export const OPENAI_CODEX_PROVIDER: ProviderDefinition<
  typeof OPENAI_CODEX_PROVIDER_ID,
  OpenAICodexModel,
  OpenAICodexEffort
> = {
  id: OPENAI_CODEX_PROVIDER_ID,
  displayName: "OpenAI Codex",
  defaultModel: "gpt-5.6-sol",
  defaultEffort: "high",
  authMethods: ["oauth"],
  todoToolName: "update_plan",
  models: OPENAI_CODEX_MODELS,
  efforts: OPENAI_CODEX_EFFORTS,
};

// --- Registry -------------------------------------------------------------------

export const PROVIDERS: Record<ProviderId, ProviderDefinition<ProviderId>> = {
  "claude-code": CLAUDE_PROVIDER,
  "openai-codex": OPENAI_CODEX_PROVIDER,
};

export const PROVIDER_LIST: ProviderDefinition<ProviderId>[] = Object.values(PROVIDERS);

export function getProviderDefinition(providerId: ProviderId): ProviderDefinition<ProviderId> {
  return PROVIDERS[providerId];
}

export function getProviderTodoToolName(providerId: ProviderId): string {
  return getProviderDefinition(providerId).todoToolName;
}

export function isProviderTodoToolName(toolName: string): boolean {
  return PROVIDER_LIST.some((provider) => provider.todoToolName === toolName);
}

export function getProviderModelIds(providerId: ProviderId): ProviderModelId[] {
  return PROVIDERS[providerId].models.map((model) => model.id);
}

export function getProviderModelDefinition(
  providerId: ProviderId,
  modelId: string,
): ProviderModelDefinition | null {
  return PROVIDERS[providerId].models.find((model) => model.id === modelId) ?? null;
}

export function isProviderModel(providerId: ProviderId, modelId: string): boolean {
  return getProviderModelDefinition(providerId, modelId) !== null;
}

export function getProviderEffortIds(providerId: ProviderId): ProviderEffortId[] {
  return PROVIDERS[providerId].efforts.map((effort) => effort.id);
}

export function getProviderEffortDefinition(
  providerId: ProviderId,
  effortId: string,
): ProviderEffortDefinition | null {
  return PROVIDERS[providerId].efforts.find((effort) => effort.id === effortId) ?? null;
}

export function isProviderEffort(providerId: ProviderId, effortId: string): boolean {
  return getProviderEffortDefinition(providerId, effortId) !== null;
}
