import {
  DEFAULT_AGENT_SETTINGS,
  type ClientState,
} from "@repo/shared";

/** Builds the Agents SDK state for a session before initialization. */
export function createSessionAgentInitialState(): ClientState {
  return {
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
  };
}
