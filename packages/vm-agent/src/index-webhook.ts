/**
 * Webhook-mode vm-agent entrypoint. The process is spawned fresh per turn
 * with the initial user message loaded from a sprite-local payload file;
 * chunk/event delivery back to the DO flows via HTTPS webhooks.
 */
import { parseArgs } from "util";
import { createInterface } from "readline";
import {
  AgentInputMessage,
  AgentSettings,
  type AgentMode,
} from "@repo/shared";
import type { AgentProviderConfig } from "./lib/agent-harness";
import { loadInitialMessageFromFile } from "./lib/webhook-initial-message";
import type { WebhookStdinLogger } from "./lib/webhook-stdin";
import { handleWebhookStdinLine } from "./lib/webhook-stdin";
import { claudeCodeProvider } from "./providers/claude-code";
import { codexProvider } from "./providers/codex";
import { WebhookAgentRunner } from "./webhook-agent-runner";

// The api-server spawns us with stdout/stderr already redirected to a file on
// the sprite (~/.cloude/logs/<sessionId>.log)
function consoleLogger(
  level: "debug" | "warn",
  message: string,
  runId: string,
  meta?: unknown,
): void {
  const line = `[${new Date().toISOString()}] [${level}] [${runId}] ${message}`;
  if (level === "warn") {
    console.warn(line, meta ?? "");
  } else {
    console.log(line, meta ?? "");
  }
}

function createLogger(runId: string): WebhookStdinLogger {
  return (level: "debug" | "warn", message: string, meta?: unknown) => {
    consoleLogger(level, message, runId, meta);
  };
}

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    sessionId: { type: "string", short: "s" },
    agentMode: { type: "string" },
    initialMessage: { type: "string" },
    initialMessagePath: { type: "string" },
    userMessageId: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
  },
  strict: false,
});

function requireString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${name} flag`);
  }
  return value;
}

function loadInitialMessage() {
  if (
    typeof values.initialMessagePath === "string" &&
    values.initialMessagePath.length > 0
  ) {
    return loadInitialMessageFromFile(values.initialMessagePath);
  }

  return AgentInputMessage.parse(
    JSON.parse(requireString("initialMessage", values.initialMessage)),
  );
}

const settings = AgentSettings.parse(
  JSON.parse(requireString("provider", values.provider)),
);
const userMessageId = requireString("userMessageId", values.userMessageId);
const initialMessage = loadInitialMessage();

const webhookUrl = process.env.DO_WEBHOOK_URL;
const webhookToken = process.env.DO_WEBHOOK_TOKEN;
// "gateway" means the webhook base is a connector gateway URL: the gateway
// authenticates this VM and injects the credential, so no token is held here.
const gatewayAuth = process.env.DO_WEBHOOK_AUTH === "gateway";
const processRunId = process.env.AGENT_PROCESS_RUN_ID;
if (!webhookUrl) { throw new Error("Missing DO_WEBHOOK_URL env var"); }
if (!webhookToken && !gatewayAuth) { throw new Error("Missing DO_WEBHOOK_TOKEN env var"); }
if (!processRunId) { throw new Error("Missing AGENT_PROCESS_RUN_ID env var"); }

const args = {
  sessionId: typeof values.sessionId === "string" ? values.sessionId : undefined,
};
const initialAgentMode: AgentMode = values.agentMode === "plan" ? "plan" : "edit";
const idleTimeoutMs = process.env.IDLE_TIMEOUT_MS
  ? Number(process.env.IDLE_TIMEOUT_MS)
  : undefined;
const heartbeatIntervalMs = process.env.VM_AGENT_HEARTBEAT_INTERVAL_MS
  ? Number(process.env.VM_AGENT_HEARTBEAT_INTERVAL_MS)
  : undefined;
const batchMaxChunks = process.env.BATCH_MAX_CHUNKS
  ? Number(process.env.BATCH_MAX_CHUNKS)
  : undefined;
const batchMaxAgeMs = process.env.BATCH_MAX_AGE_MS
  ? Number(process.env.BATCH_MAX_AGE_MS)
  : undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providerConfig: AgentProviderConfig<any> =
  settings.provider === "claude-code"
    ? claudeCodeProvider
    : codexProvider;

// unique identifier for this running instance.
const runId = crypto.randomUUID();

const logger = createLogger(runId);

const runner = new WebhookAgentRunner({
  config: providerConfig,
  settings,
  webhookUrl,
  webhookToken: gatewayAuth ? null : webhookToken!,
  processRunId,
  args,
  initialAgentMode,
  idleTimeoutMs,
  heartbeatIntervalMs,
  batchMaxChunks,
  batchMaxAgeMs,
  logger,
});

// Kick off the initial turn immediately. The runner converts overrides into
// a harness modelId / agentMode switch before dispatching.
runner.queueMessage(userMessageId, initialMessage, {
  model: typeof values.model === "string" ? values.model : undefined,
  effort: typeof values.effort === "string" ? values.effort : undefined,
  agentMode: values.agentMode === "plan" ? "plan" : undefined,
});

const readline = createInterface({ input: process.stdin });
readline.on("line", (line) => {
  handleWebhookStdinLine(line, runner, logger);
});
