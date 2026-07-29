/**
 * Drives the agent harness with webhook-based delivery. Stream chunks go
 * through the ChunkBatcher and land on POST /chunks; every other output
 * (sessionId, ready, heartbeat, error, debug, process_exit) goes on POST
 * /events, one event per request.
 */
import {
  type AgentInputMessage,
  type AgentMode,
  type AgentOutput,
  type AgentSettings,
  encodeAgentOutput,
} from "@repo/shared";
import type { UIMessageChunk } from "ai";
import {
  type AgentHarnessHandle,
  type AgentProviderConfig,
  type AgentTurnEndResult,
  startAgentHarness,
} from "./lib/agent-harness";
import { ChunkBatcher, type ChunkBatchItem } from "./lib/chunk-batcher";
import { WebhookClient } from "./lib/webhook-client";

export interface WebhookAgentRunnerOptions<S extends AgentSettings = AgentSettings> {
  config: AgentProviderConfig<S>;
  settings: S;
  webhookUrl: string;
  /** Bearer for webhook posts; null when the gateway injects the credential. */
  webhookToken: string | null;
  processRunId?: string;
  args?: { sessionId?: string };
  initialAgentMode?: AgentMode;
  idleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  batchMaxChunks?: number;
  batchMaxAgeMs?: number;
  /** Hook for runner shutdown — defaults to process.exit(exitCode). */
  onShutdown?: (_exitCode?: number) => void;
  logger?: (_level: "debug" | "warn", _message: string, _meta?: unknown) => void;
}

/** Amount of time after a turn ends waiting for new turns to come in, before shutting down. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/**
 * Sprites suspend processes after roughly 30s without stdout activity. Keep
 * this below that threshold so the vm-agent stays reusable while active or
 * idle.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Maximum number of chunks to buffer before flushing. */
const DEFAULT_BATCH_MAX_CHUNKS = 50;
/** Maximum age of a chunk batch before flushing. */
const DEFAULT_BATCH_MAX_AGE_MS = 200;
/** Hard cap on shutdown draining duration so a wedged webhook retry can't block exit. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

class WebhookEventHandler {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly httpClient: WebhookClient) {}

  post(event: AgentOutput): void {
    const promise = this.httpClient.post("/events", { event });
    this.track(promise);
  }

  async postAndWait(event: AgentOutput): Promise<void> {
    const promise = this.httpClient.post("/events", { event });
    this.track(promise);
    try {
      await promise;
    } catch {
      // WebhookClient normally absorbs retry exhaustion, but tests and future
      // clients may throw. Shutdown should still proceed after tracking settles.
    }
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pending.delete(promise));
  }

  async awaitAll(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

export class WebhookAgentRunner<S extends AgentSettings = AgentSettings> {
  private readonly harness: AgentHarnessHandle;
  private readonly batcher: ChunkBatcher;
  private readonly httpClient: WebhookClient;
  private readonly webhookEventHandler: WebhookEventHandler;
  private readonly processRunId: string;
  private readonly idleTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly onShutdown: (_exitCode?: number) => void;
  private readonly log: NonNullable<WebhookAgentRunnerOptions["logger"]>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private activeUserMessageId: string | null = null;
  private shuttingDown = false;

  constructor(private readonly opts: WebhookAgentRunnerOptions<S>) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.processRunId = opts.processRunId ?? crypto.randomUUID();
    this.onShutdown = opts.onShutdown ?? ((exitCode = 0) => process.exit(exitCode));
    this.log = opts.logger ?? (() => {});

    this.httpClient = new WebhookClient(opts.webhookUrl, opts.webhookToken, {
      logger: this.log,
    });
    this.webhookEventHandler = new WebhookEventHandler(this.httpClient);

    this.batcher = new ChunkBatcher({
      maxChunks: opts.batchMaxChunks ?? DEFAULT_BATCH_MAX_CHUNKS,
      maxAgeMs: opts.batchMaxAgeMs ?? DEFAULT_BATCH_MAX_AGE_MS,
      flush: (batch) => this.flushChunkBatch(batch),
    });

    this.harness = startAgentHarness({
      config: opts.config,
      settings: opts.settings,
      args: opts.args,
      initialAgentMode: opts.initialAgentMode,
      emit: (output) => this.handleEmit(output),
      onTurnStart: (_message, userMessageId) => this.onTurnStart(userMessageId),
      onTurnEnd: (result) => this.onTurnEnd(result),
      onSetupError: (error) => this.onSetupError(error),
    });

    this.installSignalHandlers();
    this.startHeartbeatInterval();
  }

  /**
   * Queues a user turn and tags outbound chunks with the given userMessageId.
   */
  queueMessage(
    userMessageId: string,
    message: AgentInputMessage,
    overrides?: { model?: string; effort?: string; agentMode?: AgentMode },
  ): void {
    this.cancelIdleTimer();
    this.harness.queueMessage(message, userMessageId, overrides);
  }

  /**
   * Queues a user turn from stdin and emits a typed ack once accepted.
   */
  queueStdinMessage(
    userMessageId: string,
    message: AgentInputMessage,
    overrides?: { model?: string; effort?: string; agentMode?: AgentMode },
  ): void {
    this.queueMessage(userMessageId, message, overrides);
    this.handleEmit({ type: "stdin_ack", userMessageId });
  }

  cancelTurn(userMessageId: string): void {
    const canceled = this.harness.cancelTurn(userMessageId);
    if (canceled) {
      this.handleEmit({ type: "cancel_ack", userMessageId });
    }
  }

  /**
   * Cancels the in-flight turn (if any), waits for the harness to drain its
   * abort terminal chunk through the batcher, then exits. Bounded by
   * `SHUTDOWN_DRAIN_TIMEOUT_MS` so a stuck webhook retry can't block exit.
   *
   * Used by both the idle timer and the SIGTERM/SIGINT handlers — the cancel
   * step is a no-op when no turn is active.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) { return; }
    this.shuttingDown = true;
    this.log("debug", "shutting down.");

    // Aborting the current streamText causes the harness to emit a terminal
    // abort chunk into the batcher (forcing a flush), so the DO finalizes
    // the turn through the normal terminal-chunk path.
    const canceled = this.harness.cancelTurn();
    if (canceled) {
      this.log("debug", "cancelled in-flight turn");
    }

    await this.harness.shutdown();
    await this.finishShutdown(0);
  }

  private handleEmit(output: AgentOutput): void {
    switch (output.type) {
      case "stream":
        this.batcher.add(output.chunk as UIMessageChunk);
        return;
      case "stdin_ack":
      case "cancel_ack":
        // Write directly to stdout so the attaching DO can await the ack.
        process.stdout.write(encodeAgentOutput(output) + "\n");
        return;
      case "ready":
        process.stdout.write(encodeAgentOutput(output) + "\n");
        this.log("debug", "emit ready -> stdout");
        this.log("debug", "emit event -> /events", { ...output });
        this.webhookEventHandler.post(output);
        return;
      case "error":
      case "sessionId":
      case "process_exit":
        this.log("debug", "emit event -> /events", { ...output });
        this.webhookEventHandler.post(output);
        return;
      case "heartbeat":
        // write directly to stdout to keep process alive.
        process.stdout.write(encodeAgentOutput(output) + "\n");
        this.log("debug", "emit heartbeat -> stdout");
        return;
      case "debug":
        // dont forward these to webhook, just log locally.
        this.log("debug", output.message);
        return;
      default: {
        const exhaustiveCheck: never = output;
        throw new Error(`Unhandled agent output: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private async flushChunkBatch(batch: ChunkBatchItem[]): Promise<void> {
    const userMessageId = this.activeUserMessageId;
    if (!userMessageId) {
      this.log("warn", "dropping chunk batch with no active userMessageId", {
        size: batch.length,
      });
      return;
    }
    this.log("debug", "flushing chunk batch -> /chunks", {
      userMessageId,
      size: batch.length,
      firstSeq: batch[0]?.sequence,
      lastSeq: batch[batch.length - 1]?.sequence,
    });
    await this.httpClient.post("/chunks", { userMessageId, chunks: batch });
  }

  private onTurnStart(userMessageId: string): void {
    this.cancelIdleTimer();
    this.activeUserMessageId = userMessageId;
  }

  private async onTurnEnd(_result: AgentTurnEndResult): Promise<void> {
    const endedUserMessageId = this.activeUserMessageId;
    // The DO learns about turn completion from the terminal stream chunk
    // inside the last batch — we just flush and arm the idle timer here.
    await this.batcher.flushNow();
    // Reset the per-process sequence counter so the next turn (if a future
    // long-lived runner reuses this process) starts at seq 0, matching the
    // DO's first-chunk expectation.
    this.batcher.reset();
    if (this.activeUserMessageId === endedUserMessageId) {
      this.activeUserMessageId = null;
    }
    if (!this.shuttingDown) { this.startIdleTimer(); }
  }

  private async onSetupError(_error: unknown): Promise<void> {
    if (this.shuttingDown) { return; }
    this.shuttingDown = true;
    this.log("debug", "shutting down after setup error.");

    await this.finishShutdown(1);
  }

  private async drainOutboundWithDeadline(): Promise<void> {
    const drain = Promise.allSettled([
      this.batcher.flushNow(),
      this.webhookEventHandler.awaitAll(),
    ]).then(() => undefined);
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });
    await Promise.race([drain, deadline]);
  }

  private async finishShutdown(exitCode: number): Promise<void> {
    this.cancelIdleTimer();
    this.cancelHeartbeatInterval();

    await this.drainOutboundWithDeadline();
    await this.postProcessExitWithDeadline(exitCode);

    this.log("debug", "shutdown complete", { exitCode });
    this.onShutdown(exitCode);
  }

  private async postProcessExitWithDeadline(exitCode: number): Promise<void> {
    const post = this.webhookEventHandler.postAndWait({
      type: "process_exit",
      processRunId: this.processRunId,
      exitCode,
    });
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });
    await Promise.race([post, deadline]);
  }

  private installSignalHandlers(): void {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        this.log("warn", `received ${signal}, draining and exiting`);
        void this.shutdown();
      });
    }
  }

  private startIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.shutdown();
    }, this.idleTimeoutMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startHeartbeatInterval(): void {
    this.handleEmit({ type: "heartbeat" });
    this.heartbeatInterval = setInterval(() => {
      this.handleEmit({ type: "heartbeat" });
    }, this.heartbeatIntervalMs);
  }

  private cancelHeartbeatInterval(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
