import { z } from "zod";
import { ProviderId } from "./providers";

export const SessionStatus = z.enum([
  /** Session setup is still in progress. */
  "preparing",
  /** Session setup stopped after a blocking task failed. */
  "setup_failed",
  /** Ready to send and receive messages */
  "ready",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionSetupRunStatus = z.enum(["running", "completed", "failed"]);
export type SessionSetupRunStatus = z.infer<typeof SessionSetupRunStatus>;

export const SessionSetupTaskStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type SessionSetupTaskStatus = z.infer<typeof SessionSetupTaskStatus>;

export const SessionSetupTaskOutput = z.object({
  exitCode: z.number().int().nullable(),
  /** True when the stored output hit the per-stream storage cap. */
  truncated: z.boolean(),
  /** Total stored output chars per stream. Absent on runs from before output streaming. */
  stdoutLength: z.number().int().optional(),
  stderrLength: z.number().int().optional(),
  /** Inline output from runs before output streaming. New runs never write these; full output is fetched on demand. */
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type SessionSetupTaskOutput = z.infer<typeof SessionSetupTaskOutput>;

export const StartupScriptSetupTaskSkipReason = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("no_environment"),
    repoId: z.number().int(),
  }),
  z.object({
    kind: z.literal("no_script"),
    environmentId: z.string(),
    environmentName: z.string().nullable(),
  }),
]);
export type StartupScriptSetupTaskSkipReason = z.infer<typeof StartupScriptSetupTaskSkipReason>;

const BaseSessionSetupTask = z.object({
  status: SessionSetupTaskStatus,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
});

/** Structural base for setup tasks; the union variants narrow id and the flags to literals. */
export type BaseSessionSetupTask = z.infer<typeof BaseSessionSetupTask> & {
  id: string;
  isBlocking: boolean;
  canRetry: boolean;
};

export const CloudContainerSetupTask = BaseSessionSetupTask.extend({
  id: z.literal("cloud_container"),
  isBlocking: z.literal(true),
  canRetry: z.literal(true),
});
export type CloudContainerSetupTask = z.infer<typeof CloudContainerSetupTask>;

export const SessionConnectorSetupTask = BaseSessionSetupTask.extend({
  id: z.literal("session_connector"),
  isBlocking: z.literal(true),
  canRetry: z.literal(true),
});
export type SessionConnectorSetupTask = z.infer<typeof SessionConnectorSetupTask>;

export const RepositorySetupTask = BaseSessionSetupTask.extend({
  id: z.literal("repository"),
  isBlocking: z.literal(true),
  canRetry: z.literal(true),
});
export type RepositorySetupTask = z.infer<typeof RepositorySetupTask>;

export const StartupScriptSetupTask = BaseSessionSetupTask.extend({
  id: z.literal("setup_script"),
  isBlocking: z.literal(false),
  canRetry: z.literal(false),
  output: SessionSetupTaskOutput.nullable(),
  skipReason: StartupScriptSetupTaskSkipReason.nullable(),
});
export type StartupScriptSetupTask = z.infer<typeof StartupScriptSetupTask>;

export const NetworkPolicySetupTask = BaseSessionSetupTask.extend({
  id: z.literal("network_policy"),
  isBlocking: z.literal(true),
  canRetry: z.literal(true),
});
export type NetworkPolicySetupTask = z.infer<typeof NetworkPolicySetupTask>;

export const SessionSetupTask = z.discriminatedUnion("id", [
  CloudContainerSetupTask,
  SessionConnectorSetupTask,
  RepositorySetupTask,
  StartupScriptSetupTask,
  NetworkPolicySetupTask,
]);
export type SessionSetupTask = z.infer<typeof SessionSetupTask>;

export type SessionSetupTaskId = SessionSetupTask["id"];

export const SessionSetupRun = z.object({
  id: z.string(),
  status: SessionSetupRunStatus,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  tasks: z.array(SessionSetupTask),
});
export type SessionSetupRun = z.infer<typeof SessionSetupRun>;

export const PullRequestState = z.enum(["open", "merged", "closed"]);
export type PullRequestState = z.infer<typeof PullRequestState>;

export const PullRequestClientState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("creating"),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    details: z.string().optional(),
  }),
  z.object({
    status: z.literal("created"),
    url: z.string(),
    number: z.number().int(),
    state: PullRequestState,
  }),
]);
export type PullRequestClientState = z.infer<typeof PullRequestClientState>;

export const SessionWorkingState = z.enum(["idle", "responding"]);
export type SessionWorkingState = z.infer<typeof SessionWorkingState>;

/** Generic provider auth state for the frontend. */
export type ProviderAuthRequired = {
  providerId: ProviderId;
  state: "auth_required" | "reauth_required";
} | null;

export const SessionAccessBlockReason = z.enum([
  "INSTALLATION_DELETED",
  "INSTALLATION_SUSPENDED",
  "REPO_REMOVED_FROM_INSTALLATION",
  /** Access denied during runtime auth check - unknown reason (potentially user lost access or webhook out of date) */
  "ACCESS_CHECK_DENIED",
]);
export type SessionAccessBlockReason = z.infer<typeof SessionAccessBlockReason>;

export const SessionTodoStatus = z.enum(["pending", "in_progress", "completed"]);
export type SessionTodoStatus = z.infer<typeof SessionTodoStatus>;

export const SessionTodo = z.object({
  id: z.string().optional(),
  content: z.string(),
  activeForm: z.string().optional(),
  status: SessionTodoStatus,
});
export type SessionTodo = z.infer<typeof SessionTodo>;

export const SessionPlanMetadata = z.object({
  lastUpdated: z.string(),
});
export type SessionPlanMetadata = z.infer<typeof SessionPlanMetadata>;

export const ProviderConnectionState = z.object({
  provider: ProviderId,
  connected: z.boolean(),
  requiresReauth: z.boolean(),
});
export type ProviderConnectionState = z.infer<typeof ProviderConnectionState>;

export const ActiveTurnState = z.object({
  userMessageId: z.string().min(1),
});
export type ActiveTurnState = z.infer<typeof ActiveTurnState>;

export const AgentMode = z.enum(["edit", "plan"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** Supported agent providers */
export const AgentProvider = ProviderId;
export type AgentProvider = z.infer<typeof AgentProvider>;

/** Partial settings for create/init requests; validated and merged in the DO */
export const AgentSettingsInput = z.object({
  provider: ProviderId.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxTokens: z.number().int().optional(),
});
export type AgentSettingsInput = z.infer<typeof AgentSettingsInput>;

/** A chat message */
export const Message = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolCalls: z.array(z.unknown()).optional(),
  streamPosition: z.number().int().optional(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;

/** Summary of a session for the session list */
export const SessionSummary = z.object({
  id: z.uuid(),
  repoId: z.number().int(),
  repoFullName: z.string(),
  provider: ProviderId.optional(),
  title: z.string().nullable(),
  archived: z.boolean(),
  status: SessionStatus.optional()
    .describe("preparing: setup in progress; setup_failed: setup blocked by a failure; ready: accepting messages"),
  workingState: SessionWorkingState,
  pushedBranch: z.string().nullable(),
  pullRequest: z.object({
    url: z.string(),
    number: z.number().int(),
    state: PullRequestState,
  }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  lastAssistantMessageId: z.string().nullable(),
  hasUnread: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
