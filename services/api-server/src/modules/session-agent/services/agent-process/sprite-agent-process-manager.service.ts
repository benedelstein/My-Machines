import {
  type AgentInputAttachment,
  type AgentInputMessage,
  type AgentMode,
  type AgentSettings,
  type ClientState,
  type Logger,
  type Result,
  type SessionEnvironmentSnapshot,
  encodeAgentInput,
  failure,
  success,
} from "@repo/shared";
import type { Env } from "@/shared/types";
import {
  SpritesError,
  WorkersSpriteClient,
  type SpriteWebsocketSession,
} from "@repo/sprites-client";
import { createLogger } from "@/shared/logging";
import VM_AGENT_WEBHOOK_SCRIPT from "@repo/vm-agent/dist/vm-agent-webhook.bundle.js";
import { AgentAttachmentService } from "../agent-attachment.service";
import type { SecretRepository } from "../../repositories/secret.repository";
import type { ServerState } from "../../repositories/server-state.repository";
import type {
  DispatchMessageInput,
  SpriteAgentProcessManagerError,
} from "../../types/agent-process-manager.types";
import {
  managerError,
  mapAttachmentResolutionError,
  mapProviderCredentialError,
  type AuthCredentialSnapshot,
  type ProviderCredentialError,
} from "../../types/agent-process-manager.types";
import {
  continueWaiting,
  hashScript,
  lineMatchesAgentOutput,
  rejectWaiting,
  resolveWaiting,
  type SessionSignalDecision,
  waitForSessionSignals,
} from "../../utils/agent-process-manager.utils";
import { writeCredentialFiles, writeVmAgentScript } from "./write-files.service";

const HOME_DIR = "/home/sprite";
const WORKSPACE_DIR = "/home/sprite/workspace";
const APP_DIR = `${HOME_DIR}/.cloude`;
const VM_AGENT_LOG_DIR = `${APP_DIR}/logs`;
const VM_AGENT_SCRIPT_PATH = `${APP_DIR}/agent-webhook.js`;
const VM_AGENT_MESSAGE_DIR = `${APP_DIR}/turns`;

const FRESH_START_READY_TIMEOUT_MS = 30_000;

export interface ProviderCredentialAdapter {
  getCredentialSnapshot(userId: string): Promise<Result<AuthCredentialSnapshot, ProviderCredentialError>>;
}

export interface SpriteAgentProcessManagerDeps {
  env: Env;
  logger: Logger;
  secretRepository: SecretRepository;
  getServerState: () => ServerState;
  updateAgentProcessState: (partial: Pick<ServerState, "agentProcessId" | "agentProcessRunId">) => void;
  getClientState: () => ClientState;
  getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  getProviderCredentialAdapter(
    provider: AgentSettings["provider"],
    env: Env,
    logger: Logger,
  ): ProviderCredentialAdapter;
}

export type DispatchMessageResult = Result<
  { agentProcessId: number },
  SpriteAgentProcessManagerError
>;

type ExistingProcessDispatchResult =
  | { status: "reused"; agentProcessId: number }
  | { status: "fallback" }
  | { status: "failed"; error: SpriteAgentProcessManagerError };

type CancelActiveTurnResult = {
  processPreserved: boolean;
};

/**
 * Owns the lifecycle of the vm-agent process on the sprite for a session.
 *
 * Reuses the vm-agent process while it is alive inside its post-turn idle
 * window. New turns are sent to the existing process via stdin. If the saved
 * sprite process id is stale (or attach/write fails), the id is cleared and a
 * fresh process is spawned with the initial turn staged on disk.
 *
 * `cancelActiveTurn()` gracefully cancels the active turn when possible and
 * falls back to terminating the exec session. `kill()` is used on session
 * delete.
 */
export class SpriteAgentProcessManager {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly secretRepository: SecretRepository;
  private readonly getServerState: () => ServerState;
  private readonly updateAgentProcessState: SpriteAgentProcessManagerDeps["updateAgentProcessState"];
  private readonly getClientState: () => ClientState;
  private readonly getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  private readonly attachmentService: AgentAttachmentService;
  private readonly getProviderCredentialAdapter: SpriteAgentProcessManagerDeps["getProviderCredentialAdapter"];

  /** In-flight spawn promise, or null if no spawn is running. */
  private startMutex: Promise<DispatchMessageResult> | null = null;
  /** Cached sha 256 of script bundle to avoid writing it to the sprite on every dispatch */
  private cachedBundleHash: string | null = null;

  constructor(deps: SpriteAgentProcessManagerDeps) {
    this.env = deps.env;
    this.logger = deps.logger.scope("sprite-agent-process-manager");
    this.secretRepository = deps.secretRepository;
    this.getServerState = deps.getServerState;
    this.updateAgentProcessState = deps.updateAgentProcessState;
    this.getClientState = deps.getClientState;
    this.getEnvironmentSnapshot = deps.getEnvironmentSnapshot;
    this.attachmentService = new AgentAttachmentService(deps.env, this.logger);
    this.getProviderCredentialAdapter = deps.getProviderCredentialAdapter;
  }

  /**
   * Dispatches a turn to the vm-agent. Prefers attaching to the saved sprite
   * process id and writing the turn to stdin; falls back to spawning a fresh
   * process when the saved id is missing or stale. Concurrent callers share a
   * single in-flight operation so back-to-back dispatches cannot race to write
   * or spawn twice.
   */
  async dispatchMessage(
    input: DispatchMessageInput,
  ): Promise<DispatchMessageResult> {
    if (this.startMutex) {
      return this.startMutex;
    }

    const spawn = (async (): Promise<DispatchMessageResult> => {
      try {
        return await this.doDispatch(input);
      } finally {
        this.startMutex = null;
      }
    })();
    this.startMutex = spawn;
    return spawn;
  }

  /**
   * Best-effort cancels the active turn. When the process acknowledges the
   * scoped cancel it can be reused; otherwise it is fenced with SIGTERM.
   */
  async cancelActiveTurn(): Promise<CancelActiveTurnResult> {
    const serverState = this.getServerState();
    const processId = serverState.agentProcessId;
    const spriteName = serverState.spriteName;
    const userMessageId = serverState.activeUserMessageId;
    if (!processId || !spriteName || !userMessageId) {
      this.logger.debug("No active agent process to cancel");
      return { processPreserved: false };
    }

    const sprite = this.getSpriteClient();
    const session = sprite.attachSession(String(processId), {
      idleTimeoutMs: 10_000,
    });

    try {
      await session.start();
      const cancelAck = this.waitForAck(
        session,
        "cancel_ack",
        userMessageId,
        2_000,
      );
      session.write(`${encodeAgentInput({ type: "cancel", userMessageId })}\n`);
      await cancelAck;
      this.logger.debug("Agent process acknowledged turn cancel");
      return { processPreserved: true };
    } catch (error) {
      this.logger.warn("Graceful agent cancel failed; terminating process", {
        error,
        fields: { processId, userMessageId },
      });
      await this.killActiveProcess(sprite, processId, error);
      return { processPreserved: false };
    } finally {
      try {
        session.close();
      } catch (error) {
        this.logger.debug("Failed to close cancel attach websocket", { error });
      }
    }
  }

  /** Terminates the cached active process and clears its id. */
  async terminateActiveProcess(): Promise<void> {
    const serverState = this.getServerState();
    const processId = serverState.agentProcessId;
    const spriteName = serverState.spriteName;
    if (!processId || !spriteName) {
      return;
    }

    const sprite = this.getSpriteClient();
    await this.killActiveProcess(
      sprite,
      processId,
      new Error("terminating active process"),
    );
  }

  /** Force-kills the active agent process. Used on session delete. */
  async kill(): Promise<void> {
    const serverState = this.getServerState();
    const processId = serverState.agentProcessId;
    const spriteName = serverState.spriteName;
    if (!processId || !spriteName) {
      return;
    }

    const sprite = this.getSpriteClient();
    try {
      await sprite.killSession(processId, "SIGTERM");
    } catch (error) {
      if (!(error instanceof SpritesError && error.statusCode === 404)) {
        this.logger.warn("Failed to kill agent process", { error });
      }
    }
    this.clearAgentProcessState();
  }

  /**
   * Returns the per-session webhook bearer token, generating and persisting
   * it on first use.
   */
  ensureWebhookToken(): string {
    const existing = this.secretRepository.get("webhook_token");
    if (existing) {
      return existing;
    }
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    this.secretRepository.set("webhook_token", token);
    return token;
  }

  // ============================================
  // Private
  // ============================================

  private async doDispatch(
    input: DispatchMessageInput,
  ): Promise<DispatchMessageResult> {
    const serverState = this.getServerState();
    const clientState = this.getClientState();
    const sessionId = serverState.sessionId;
    const spriteName = serverState.spriteName;
    const userId = serverState.userId;

    if (!sessionId || !spriteName || clientState.sessionSetupRun?.status !== "completed") {
      return failure(
        managerError(
          "SESSION_NOT_READY",
          "Session provisioning is not complete",
        ),
      );
    }
    if (!userId) {
      return failure(
        managerError("USER_NOT_FOUND", "Session user id is missing"),
      );
    }

    const settings: AgentSettings =
      input.model || input.effort
        ? ({
            ...clientState.agentSettings,
            model: input.model ?? clientState.agentSettings.model,
            effort: input.effort ?? clientState.agentSettings.effort,
          } as AgentSettings)
        : clientState.agentSettings;
    const agentMode: AgentMode = input.agentMode ?? clientState.agentMode;

    const spriteClient = this.getSpriteClient();

    let agentMessage: AgentInputMessage | null = null;
    if (serverState.agentProcessId) {
      const messageResult = await this.resolveAgentMessage(
        sessionId,
        input.userMessage,
      );
      if (!messageResult.ok) {
        return failure(messageResult.error);
      }
      agentMessage = messageResult.value;

      const reuseResult = await this.tryDispatchToExistingProcess(spriteClient, {
        processId: serverState.agentProcessId,
        userMessageId: input.userMessage.id,
        message: agentMessage,
        model: input.model,
        effort: input.effort,
        agentMode: input.agentMode,
      });
      switch (reuseResult.status) {
        case "reused":
          return success({ agentProcessId: reuseResult.agentProcessId });
        case "failed":
          return failure(reuseResult.error);
        case "fallback":
          break;
      }
    }

    // can't reuse, so start a new agent process.
    return await this.tryDispatchToNewProcess(spriteClient, {
      userMessageId: input.userMessage.id,
      userMessage: input.userMessage,
      resolvedAgentMessage: agentMessage,
      sessionId,
      userId,
      model: input.model,
      effort: input.effort,
      agentMode: agentMode,
      settings
    });
  }

  private async tryDispatchToNewProcess(
    sprite: WorkersSpriteClient,
    args: {
      userMessageId: string;
      settings: AgentSettings;
      sessionId: string;
      userId: string;
      userMessage: DispatchMessageInput["userMessage"];
      resolvedAgentMessage: AgentInputMessage | null;
      model: string | undefined;
      effort: string | undefined;
      agentMode: AgentMode;
    },
  ): Promise<DispatchMessageResult> {
    const {
      settings,
      userId,
      model,
      effort,
      sessionId,
      agentMode,
      userMessageId,
    } = args;
    const messageResult = args.resolvedAgentMessage
      ? success(args.resolvedAgentMessage)
      : await this.resolveAgentMessage(sessionId, args.userMessage);
    if (!messageResult.ok) {
      return failure(messageResult.error);
    }
    const agentMessage = messageResult.value;

    const credentialResult = await this.loadCredentialSnapshot(
      settings,
      userId,
    );
    if (!credentialResult.ok) {
      return failure(credentialResult.error);
    }
    const credentialSnapshot = credentialResult.value;

    let session: SpriteWebsocketSession | null = null;
    try {
      await writeCredentialFiles(sprite, credentialSnapshot);
      await writeVmAgentScript(
        sprite,
        VM_AGENT_SCRIPT_PATH,
        VM_AGENT_WEBHOOK_SCRIPT,
        await this.getBundleHash(),
      );
      const webhookToken = this.ensureWebhookToken();
      const webhookUrl = this.buildWebhookUrl(sessionId);
      const processRunId = crypto.randomUUID();
      const environmentSnapshot = this.getEnvironmentSnapshot();

      // write the initial message to a file, messages with attachments are too large for argv
      const initialMessagePath = `${VM_AGENT_MESSAGE_DIR}/${crypto.randomUUID()}.json`;
      await this.writeInitialMessageFile(
        initialMessagePath,
        agentMessage,
      );

      // Wrap bun in a shell so stdout/stderr are mirrored to a sprite log file.
      // The initial message is staged in a file; reused turns and cancels attach
      // to this exec session later and write typed NDJSON to stdin.
      // `exec` replaces the shell with bun so we don't leak a wrapper process.
      // "$@" preserves argv boundaries so JSON args with spaces/quotes stay
      // intact.
      const agentArgs = this.buildAgentArgs({
        settings,
        agentMode,
        initialMessagePath,
        userMessageId: userMessageId,
        agentSessionId: this.getServerState().agentSessionId ?? undefined,
        model: model,
        effort: effort,
      });
      const logPath = `${VM_AGENT_LOG_DIR}/${sessionId}.log`;
      // Run inside a shell so we can tee stdout/stderr to both the sprite exec
      // TTY and a log file. Sprites only appear to keep detached sessions awake
      // while there is TTY output, so plain file redirection is not enough. We
      // intentionally do NOT wrap with setsid/nohup — `detachable: true` puts
      // the process inside a tmux session on the sprite, and setsid would tear
      // it out of tmux's session group, breaking the keep-running behavior.
      session = sprite.createSession(
        "bash",
        [
          "-c",
          `mkdir -p ${VM_AGENT_LOG_DIR} && set -o pipefail && bun "$@" 2>&1 | tee -a ${logPath}`,
          "vm-agent",
          ...agentArgs,
        ],
        {
          cwd: WORKSPACE_DIR,
          // TTY + detachable matches the sprite docs example for sessions that
          // "stay alive after disconnect". Without TTY, sessions appear to be
          // suspended once the spawn websocket closes regardless of
          // `maxRunAfterDisconnect`.
          tty: true,
          detachable: true,
          env: {
            ...environmentSnapshot.plainEnvVars,
            ...credentialSnapshot.envVars,
            ...(this.env.CODEX_MIN_VERSION
              ? { CODEX_MIN_VERSION: this.env.CODEX_MIN_VERSION }
              : {}),
            SESSION_ID: sessionId,
            DO_WEBHOOK_URL: webhookUrl,
            DO_WEBHOOK_TOKEN: webhookToken,
            AGENT_PROCESS_RUN_ID: processRunId,
          },
          idleTimeoutMs: 45_000,
          // maxRunAfterDisconnect: "0",
        },
      );

      const startResult = await this.startAndWaitForReady(session);
      if (!startResult.ok) {
        return failure(startResult.error);
      }
      this.recordAgentProcessState(startResult.value, processRunId);
      return success({ agentProcessId: startResult.value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const spawnError = managerError("SPAWN_FAILED", message, { cause: message });
      return failure(spawnError);
    } finally {
      // Close our setup websocket. The vm-agent keeps running on the sprite
      // for up to maxRunAfterDisconnect.
      if (session) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          session.close();
        } catch (error) {
          this.logger.debug("Failed to close setup websocket", { error });
        }
      }
    }
  }

  private async resolveAgentMessage(
    sessionId: string,
    userMessage: DispatchMessageInput["userMessage"],
  ): Promise<Result<AgentInputMessage, SpriteAgentProcessManagerError>> {
    const attachmentsResult = await this.attachmentService.resolveAttachments(
      sessionId,
      userMessage.attachmentIds,
    );
    if (!attachmentsResult.ok) {
      return failure(mapAttachmentResolutionError(attachmentsResult.error));
    }
    const resolvedAttachments = attachmentsResult.value.agentAttachments;

    return success({
      content: userMessage.content,
      attachments:
        resolvedAttachments.length > 0
          ? (resolvedAttachments as AgentInputAttachment[])
          : undefined,
    });
  }

  private async tryDispatchToExistingProcess(
    sprite: WorkersSpriteClient,
    args: {
      processId: number | null;
      userMessageId: string;
      message: AgentInputMessage;
      model: string | undefined;
      effort: string | undefined;
      agentMode: AgentMode | undefined;
    },
  ): Promise<ExistingProcessDispatchResult> {
    if (!args.processId) {
      return { status: "fallback" };
    }

    const session = sprite.attachSession(String(args.processId), {
      idleTimeoutMs: 10_000,
    });
    let wroteStdin = false;

    try {
      await session.start();
      this.logger.debug(
        "Attached to existing vm-agent process; waiting for stdin ack",
        {
          fields: {
            processId: args.processId,
            userMessageId: args.userMessageId,
          },
        },
      );
      // wait for the agent process to explicitly acknowledge the message write
      const stdinAck = this.waitForAck(
        session,
        "stdin_ack",
        args.userMessageId,
        2_000,
      );
      session.write(
        `${encodeAgentInput({
          type: "chat",
          userMessageId: args.userMessageId,
          message: args.message,
          model: args.model,
          effort: args.effort,
          agentMode: args.agentMode,
        })}\n`,
      );
      wroteStdin = true;
      await stdinAck;
      this.logger.debug("Dispatched turn to existing vm-agent process", {
        fields: {
          processId: args.processId,
          userMessageId: args.userMessageId,
        },
      });
      return { status: "reused", agentProcessId: args.processId };
    } catch (error) {
      this.clearAgentProcessState();
      if (wroteStdin) {
        const processStopped = await this.killUncertainProcess(
          sprite,
          args.processId,
        );
        if (processStopped) {
          this.logger.warn(
            "Existing vm-agent process stopped before stdin ack; spawning a new one",
            {
              error,
              fields: {
                processId: args.processId,
                userMessageId: args.userMessageId,
              },
            },
          );
          return { status: "fallback" };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          error: managerError(
            "TURN_DID_NOT_START",
            "Existing vm-agent process did not acknowledge the stdin turn",
            {
              cause: message,
              processId: args.processId,
              userMessageId: args.userMessageId,
            },
          ),
        };
      }

      this.logger.warn(
        "Existing vm-agent process is not reusable; spawning a new one",
        {
          error,
          fields: {
            processId: args.processId,
            userMessageId: args.userMessageId,
          },
        },
      );
      return { status: "fallback" };
    } finally {
      try {
        // detach from the websocket on the sprite, but agent process will keep running.
        session.close();
      } catch (error) {
        this.logger.debug("Failed to close attach websocket", { error });
      }
    }
  }

  private async killUncertainProcess(
    sprite: WorkersSpriteClient,
    processId: number,
  ): Promise<boolean> {
    this.logger.debug(
      "Existing vm-agent process did not ack stdin; killing it",
    );
    try {
      await sprite.killSession(processId, "SIGTERM");
      this.clearAgentProcessState();
      return true;
    } catch (error) {
      if (error instanceof SpritesError && error.statusCode === 404) {
        this.logger.debug("Unacknowledged vm-agent process was already gone", {
          fields: { processId },
        });
        this.clearAgentProcessState();
        return true;
      }
      this.logger.warn("Failed to kill unacknowledged vm-agent process", {
        error,
        fields: { processId },
      });
      return false;
    }
  }

  private async killActiveProcess(
    sprite: WorkersSpriteClient,
    processId: number,
    cause: unknown,
  ): Promise<void> {
    try {
      await sprite.killSession(processId, "SIGTERM");
      this.clearAgentProcessState();
      this.logger.debug("Agent process terminated");
    } catch (error) {
      if (error instanceof SpritesError && error.statusCode === 404) {
        this.logger.debug("Agent process already gone", {
          fields: { processId },
        });
        this.clearAgentProcessState();
        return;
      }
      this.logger.warn("Failed to terminate agent process", {
        error,
        fields: {
          processId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      });
    }
  }

  private recordAgentProcessState(agentProcessId: number, agentProcessRunId: string): void {
    this.updateAgentProcessState({ agentProcessId, agentProcessRunId });
  }

  private clearAgentProcessState(): void {
    this.updateAgentProcessState({
      agentProcessId: null,
      agentProcessRunId: null,
    });
  }

  private waitForAck(
    session: SpriteWebsocketSession,
    expectedType: "stdin_ack" | "cancel_ack",
    userMessageId: string,
    timeoutMs: number,
  ): Promise<void> {
    const ackName = expectedType === "stdin_ack" ? "stdin ack" : "cancel ack";
    return waitForSessionSignals(session, {
      timeoutMs,
      onStdoutLine: (line) =>
        lineMatchesAgentOutput(
          line,
          (output) =>
            output.type === expectedType &&
            output.userMessageId === userMessageId,
        )
          ? resolveWaiting(undefined)
          : continueWaiting(),
      onError: (error) => rejectWaiting(error),
      onExit: (code) =>
        rejectWaiting(new Error(`vm-agent exited before ${ackName}: ${code}`)),
      onTimeout: () =>
        rejectWaiting(new Error(`Timed out waiting for ${ackName} for ${userMessageId}`)),
    });
  }

  private async loadCredentialSnapshot(
    settings: AgentSettings,
    userId: string,
  ): Promise<Result<AuthCredentialSnapshot, SpriteAgentProcessManagerError>> {
    const adapter = this.getProviderCredentialAdapter(
      settings.provider,
      this.env,
      this.logger,
    );
    const snapshot = await adapter.getCredentialSnapshot(userId);
    if (!snapshot.ok) {
      return failure(mapProviderCredentialError(snapshot.error));
    }
    return success(snapshot.value);
  }


  private async writeInitialMessageFile(
    path: string,
    message: AgentInputMessage,
  ): Promise<void> {
    const sprite = this.getSpriteClient();
    await sprite.writeFile(path, JSON.stringify(message), { mode: "0600" });
  }

  private buildAgentArgs(args: {
    settings: AgentSettings;
    agentMode: AgentMode;
    initialMessagePath: string;
    userMessageId: string;
    agentSessionId: string | undefined;
    model: string | undefined;
    effort: string | undefined;
  }): string[] {
    const cliArgs = [
      "run",
      VM_AGENT_SCRIPT_PATH,
      "--provider",
      JSON.stringify(args.settings),
      "--agentMode",
      args.agentMode,
      "--initialMessagePath",
      args.initialMessagePath,
      "--userMessageId",
      args.userMessageId,
    ];
    if (args.agentSessionId) {
      cliArgs.push("--sessionId", args.agentSessionId);
    }
    if (args.model) {
      cliArgs.push("--model", args.model);
    }
    if (args.effort) {
      cliArgs.push("--effort", args.effort);
    }
    return cliArgs;
  }

  private buildWebhookUrl(sessionId: string): string {
    return `${this.env.WORKER_URL}/internal/session/${sessionId}`;
  }

  private async startAndWaitForReady(
    session: SpriteWebsocketSession,
  ): Promise<Result<number, SpriteAgentProcessManagerError>> {
    let processId: number | null = null;
    let sawReady = false;

    const missingStartupSignal = (): string => {
      if (processId === null && !sawReady) {
        return "vm-agent session_info and ready";
      }
      if (processId === null) {
        return "vm-agent session_info";
      }
      return "vm-agent ready";
    };

    const maybeReady = (): SessionSignalDecision<Result<number, SpriteAgentProcessManagerError>> => {
      if (processId !== null && sawReady) {
        return resolveWaiting(success(processId));
      }
      return continueWaiting();
    };

    return waitForSessionSignals<Result<number, SpriteAgentProcessManagerError>>(session, {
      timeoutMs: FRESH_START_READY_TIMEOUT_MS,
      startSession: true,
      onServerMessage: (message) => {
        if (message.type === "session_info" && processId === null) {
          processId = message.session_id;
          this.logger.debug("Captured agent process id", {
            fields: { processId },
          });
        }
        return maybeReady();
      },
      onStdoutLine: (line) => {
        if (lineMatchesAgentOutput(line, (output) => output.type === "ready")) {
          sawReady = true;
        }
        return maybeReady();
      },
      onError: (error) =>
        resolveWaiting(
          failure(
            managerError(
              "TURN_DID_NOT_START",
              `${error.message} before ${missingStartupSignal()}`,
              { cause: error.message },
            ),
          ),
        ),
      onExit: (code) =>
        resolveWaiting(
          failure(
            managerError(
              "TURN_DID_NOT_START",
              `vm-agent exited before ${missingStartupSignal()}: ${code}`,
              { exitCode: code },
            ),
          ),
        ),
      onTimeout: () =>
        resolveWaiting(
          failure(
            managerError(
              "TURN_DID_NOT_START",
              `Timed out waiting for ${missingStartupSignal()}`,
            ),
          ),
        ),
    });
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async getBundleHash(): Promise<string | null> {
    if (!this.cachedBundleHash) {
      this.cachedBundleHash = await hashScript(VM_AGENT_WEBHOOK_SCRIPT);
    }
    return this.cachedBundleHash;
  }

  private getSpriteClient(): WorkersSpriteClient {
    const spriteName = this.getServerState().spriteName;
    if (!spriteName) {
      throw new Error("Sprite name is not set");
    }
    return new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
      createLogger("sprite-websocket.session.ts"),
    );
  }
}
