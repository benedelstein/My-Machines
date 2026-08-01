import { type ClientState, DEFAULT_AGENT_SETTINGS } from "@repo/api-contract";

export const getInitialClientState = (): ClientState => ({
  repoFullName: null,
  status: "preparing",
  sessionSetupRun: null,
  agentSettings: { ...DEFAULT_AGENT_SETTINGS },
  agentMode: "edit",
  pushedBranch: null,
  pullRequest: null,
  todos: null,
  plan: null,
  pendingUserMessage: null,
  activeTurn: null,
  editorUrl: null,
  providerConnection: null,
  lastError: null,
  baseBranch: null,
  createdAt: new Date().toISOString(),
});