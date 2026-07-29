import type {
  StartupScriptSetupTask,
  ClientState,
  Logger,
  SessionEnvironmentSnapshot,
  SessionSetupTaskOutput,
  SessionStatus,
  StartupScriptSetupTaskSkipReason,
  SessionSetupTaskId,
  SessionSetupRun,
  SessionSetupTask,
} from "@repo/shared";
import { dedent } from "@repo/shared";
import type { Env } from "@/shared/types";
import {
  buildBootstrapNetworkPolicy,
  buildFinalNetworkPolicy,
  WorkersSpriteClient,
  type SpriteLifecycleClient,
} from "@repo/sprites-client";
import { createLogger } from "@/shared/logging";
import { sanitizeGitBranchName, shellQuote } from "@/shared/utils/git-branch";
import { ensureSpriteStartupToolchain } from "@/shared/integrations/sprite-startup-toolchain";
import type { GitHubAppResult } from "@/shared/types/github";
import type { ServerState } from "../repositories/server-state.repository";
import { buildSessionSpriteLabels } from "./session-connector.service";
import { isTerminalSetupTask } from "./session-setup-run.service";
import {
  SessionStartupScriptService,
  type SessionStartupScriptRunResult,
} from "./session-startup-script.service";
import type {
  SessionSetupOutputCollector,
  SetupOutputFinishResult,
} from "./session-setup-output.service";

const WORKSPACE_DIR = "/home/sprite/workspace";

type ProvisionClientStateUpdate = Partial<
  Pick<ClientState, "baseBranch" | "lastError" | "status">
>;

export interface SessionSetupTaskReporter {
  startTask(taskId: SessionSetupTaskId): void;
  completeTask(
    taskId: SessionSetupTaskId,
    output?: SessionSetupTaskOutput,
  ): void;
  failTask(
    taskId: SessionSetupTaskId,
    error: string,
    output?: SessionSetupTaskOutput,
  ): void;
  skipTask(
    taskId: SessionSetupTaskId,
    skipReason?: StartupScriptSetupTaskSkipReason,
  ): void;
}

/**
 * Dependencies injected from the SessionAgentDO into the provisioner.
 * Keeps coupling explicit and avoids a circular type reference to the DO class.
 */
export interface SessionProvisionServiceDeps {
  logger: Logger;
  env: Env;
  spriteLifecycleClient: SpriteLifecycleClient;

  getServerState: () => ServerState;
  getClientState: () => ClientState;
  getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  updateServerState: (partial: Partial<ServerState>) => void;
  updatePartialState: (partial: ProvisionClientStateUpdate) => void;
  synthesizeStatus: () => SessionStatus;
  retireGitProxySecret: () => void;
  ensureSessionConnector: (spriteName: string) => Promise<void>;
  getSessionConnectorGatewayBase: () => string | null;
  githubTokenProvider: {
    getReadOnlyTokenForRepo(
      repoFullName: string,
    ): Promise<GitHubAppResult<string>>;
  };
  setupReporter?: SessionSetupTaskReporter;
  setupOutputCollector?: SessionSetupOutputCollector;
}

/**
 * Owns session VM provisioning for a SessionAgentDO: creating the sprite,
 * applying the network policy, cloning the repository, and configuring
 * git remotes. Each step is idempotent — skipped if the corresponding
 * checkpoint is already recorded in ServerState.
 *
 * The SessionAgentDO owns this instance. All interaction is through the
 * injected deps so the provisioner has no reference to the DO class.
 */
export class SessionProvisionService {
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly spriteLifecycleClient: SpriteLifecycleClient;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  private readonly updateServerState: SessionProvisionServiceDeps["updateServerState"];
  private readonly updatePartialState: SessionProvisionServiceDeps["updatePartialState"];
  private readonly synthesizeStatus: () => SessionStatus;
  private readonly retireGitProxySecret: () => void;
  private readonly ensureSessionConnector: SessionProvisionServiceDeps["ensureSessionConnector"];
  private readonly getSessionConnectorGatewayBase:
    SessionProvisionServiceDeps["getSessionConnectorGatewayBase"];
  private readonly githubTokenProvider: SessionProvisionServiceDeps["githubTokenProvider"];
  private readonly setupReporter: SessionProvisionServiceDeps["setupReporter"];
  private readonly setupOutputCollector: SessionProvisionServiceDeps["setupOutputCollector"];
  private readonly startupScriptService: SessionStartupScriptService;

  /** Mutex for durable provisioning steps (sprite creation, repo clone). */
  private ensureProvisionedPromise: Promise<void> | null = null;
  private spriteName: string | null = null;

  constructor(deps: SessionProvisionServiceDeps) {
    this.logger = deps.logger.scope("session-provision-service");
    this.env = deps.env;
    this.spriteLifecycleClient = deps.spriteLifecycleClient;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.getEnvironmentSnapshot = deps.getEnvironmentSnapshot;
    this.updateServerState = deps.updateServerState;
    this.updatePartialState = deps.updatePartialState;
    this.synthesizeStatus = deps.synthesizeStatus;
    this.retireGitProxySecret = deps.retireGitProxySecret;
    this.ensureSessionConnector = deps.ensureSessionConnector;
    this.getSessionConnectorGatewayBase = deps.getSessionConnectorGatewayBase;
    this.githubTokenProvider = deps.githubTokenProvider;
    this.setupReporter = deps.setupReporter;
    this.setupOutputCollector = deps.setupOutputCollector;
    this.startupScriptService = new SessionStartupScriptService(this.logger);
  }

  /**
   * Ensures the sprite is created and the repo is cloned. Safe to call
   * concurrently — all callers share one in-flight promise.
   */
  ensureProvisioned(): Promise<void> {
    if (this.ensureProvisionedPromise) {
      return this.ensureProvisionedPromise;
    }
    this.ensureProvisionedPromise = this.provision().finally(() => {
      this.ensureProvisionedPromise = null;
    });
    return this.ensureProvisionedPromise;
  }

  private async provision(): Promise<void> {
    this.spriteName = this.getServerState().spriteName;
    const setupRun = this.getClientState().sessionSetupRun;
    if (!setupRun) { return; }
    if (setupRun.status === "completed") {
      this.logger.debug("Setup run is completed; skipping provision", {
        fields: { setupRunStatus: setupRun.status },
      });
      return;
    }
    if (setupRun.status === "failed" && !hasRetryableFailedProvisionTask(setupRun)) {
      this.logger.debug("Setup run failure is not retryable; skipping provision", {
        fields: { setupRunStatus: setupRun.status },
      });
      return;
    }

    for (const task of setupRun.tasks) {
      const retryFailedTask = isRetryableFailedProvisionTask(task);
      if (isTerminalSetupTask(task) && !retryFailedTask) { continue; }
      try {
        this.setupReporter?.startTask(task.id);
        switch (task.id) {
          case "cloud_container":
            await this.ensureCloudContainerTask();
            break;
          case "session_connector":
            await this.ensureSessionConnectorTask(this.requireSpriteName());
            break;
          case "repository":
            await this.ensureRepositoryTask(
              this.requireSpriteName(),
            );
            break;
          case "setup_script": {
            await this.ensureSetupScriptTask(
              task,
              this.requireSpriteName(),
            );
            // dont fall through or it will be reported as completed.
            // the method handles reporting internally.
            continue; 
          }
          case "network_policy":
            await this.ensureNetworkPolicyTask(this.requireSpriteName());
            break;
          default: {
            const exhaustiveCheck: never = task;
            throw new Error(
              `Unhandled provision task: ${JSON.stringify(exhaustiveCheck)}`,
            );
          }
        }
        this.setupReporter?.completeTask(task.id);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        this.setupReporter?.failTask(task.id, errorMessage);
        if (task.isBlocking) {
          this.recordProvisioningError(error);
          throw error instanceof Error ? error : new Error(errorMessage);
        }
        this.logger.warn("Continuing after non-blocking setup task failure", {
          fields: {
            sessionId: this.getServerState().sessionId,
            taskId: task.id,
            errorMessage,
          },
        });
      }
    }
  }

  private recordProvisioningError(error: unknown): void {
    const errorMessage = getErrorMessage(error);
    this.logger.error("Failed to provision session", { error });
    this.updatePartialState({
      lastError: errorMessage,
      status: this.synthesizeStatus(),
    });
  }

  private async ensureCloudContainerTask(): Promise<void> {
    if (!this.spriteName) {
      const sessionId = this.getServerState().sessionId;
      if (!sessionId) {
        throw new Error("Session id is missing");
      }
      this.logger.debug("creating sprite", {
        fields: { sessionId },
      });
      const labels = buildSessionSpriteLabels(
        sessionId,
        this.getEnvironmentSnapshot().sourceEnvironmentId,
      );
      const spriteResponse = await this.spriteLifecycleClient.createSprite({
        name: sessionId,
        labels,
      });
      this.spriteName = spriteResponse.name;
      // For provisioning, allow network access to known-good domains.
      const sprite = new WorkersSpriteClient(
        this.spriteName!,
        this.env.SPRITES_API_KEY,
        this.env.SPRITES_API_URL,
        createLogger("sprite-websocket.session.ts"),
      );
      const workerHostname = new URL(this.env.WORKER_URL).hostname;
      const networkPolicy = buildBootstrapNetworkPolicy({
        workerHostname,
        connectorGatewayHostname: this.connectorGatewayHostname(),
      });
      await sprite.setNetworkPolicy(networkPolicy);
      this.updateServerState({
        spriteName: this.spriteName,
        spriteLabelsApplied: labels.every((label) =>
          (spriteResponse.labels ?? []).includes(label),
        ),
      });
    }
    if (!this.getServerState().startupToolchain) {
      await this.ensureStartupToolchain(this.spriteName);
    }
  }

  private async ensureSessionConnectorTask(spriteName: string): Promise<void> {
    await this.ensureSessionConnector(spriteName);
  }

  /** Gateway hostname kept reachable in restricted network modes. */
  private connectorGatewayHostname(): string {
    return new URL(this.env.SPRITES_API_URL).hostname;
  }

  private async ensureRepositoryTask(
    spriteName: string,
  ): Promise<void> {
    if (!this.getServerState().repoCloned) {
      await this.cloneRepo(spriteName);
      this.updateServerState({ repoCloned: true });
    }
    this.updatePartialState({ lastError: null });
  }

  private async ensureSetupScriptTask(
    task: StartupScriptSetupTask,
    spriteName: string,
  ): Promise<void> {
    if (this.getServerState().startupScriptCompleted) {
      return;
    }

    const environmentSnapshot = this.getEnvironmentSnapshot();
    const sprite = new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
      createLogger("sprite-websocket.session.ts"),
    );

    this.setupOutputCollector?.beginRun();
    let result: SessionStartupScriptRunResult;
    try {
      result = await this.startupScriptService.run({
        sprite,
        script: environmentSnapshot.startupScript,
        workspaceDir: WORKSPACE_DIR,
        env: environmentSnapshot.plainEnvVars,
        onOutput: (stream, data) => this.setupOutputCollector?.append(stream, data),
      });
    } catch (error) {
      // Exec transport failures (not script exit codes). Finishing the
      // collector flushes pending output and stops its timer, and the task
      // keeps whatever output was captured before the failure.
      this.updateServerState({ startupScriptCompleted: true });
      const outputInfo = this.setupOutputCollector?.finish();
      const errorMessage = getErrorMessage(error);
      this.logger.warn("Session startup script errored", {
        fields: {
          sessionId: this.getServerState().sessionId,
          errorMessage,
        },
      });
      this.setupReporter?.failTask(task.id, errorMessage, buildSetupScriptOutput(null, outputInfo));
      return;
    }
    this.updateServerState({ startupScriptCompleted: true });
    const outputInfo = this.setupOutputCollector?.finish();

    if (result.status === "failed") {
      this.logger.warn("Session startup script failed", {
        fields: {
          sessionId: this.getServerState().sessionId,
          errorMessage: result.errorMessage,
        },
      });
    }
    switch (result.status) {
      case "completed":
        this.setupReporter?.completeTask(task.id, buildSetupScriptOutput(result.exitCode, outputInfo));
        break;
      case "failed":
        this.setupReporter?.failTask(task.id, result.errorMessage, buildSetupScriptOutput(result.exitCode, outputInfo));
        break;
      case "skipped":
        this.setupReporter?.skipTask(task.id, buildSkippedSetupScriptSkipReason(this.getEnvironmentSnapshot()));
        break;
    }
  }

  private async ensureNetworkPolicyTask(
    spriteName: string,
  ): Promise<void> {
    if (!this.getServerState().finalNetworkPolicyApplied) {
      await this.applyFinalNetworkPolicy(spriteName);
      this.updateServerState({ finalNetworkPolicyApplied: true });
    }
  }

  private requireSpriteName(): string {
    const spriteName = this.spriteName;
    if (!spriteName) {
      throw new Error("Sprite name is missing");
    }
    return spriteName;
  }

  private async ensureStartupToolchain(spriteName: string): Promise<void> {
    const providerId = this.getClientState().agentSettings.provider;
    const serverState = this.getServerState();
    const sprite = new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
      createLogger("sprite-websocket.session.ts"),
    );

    this.logger.info("Ensuring startup toolchain", {
      fields: {
        sessionId: serverState.sessionId,
        spriteName,
        provider: providerId,
        checkpointPresent: serverState.startupToolchain !== null,
      },
    });

    const result = await ensureSpriteStartupToolchain({
      providerId,
      sprite,
      checkpoint: serverState.startupToolchain,
      logger: this.logger,
      codexMinVersion: this.env.CODEX_MIN_VERSION,
    });
    if (!result.ok) {
      this.logger.warn("Startup toolchain failed", {
        fields: {
          sessionId: serverState.sessionId,
          spriteName,
          provider: providerId,
          checkId: result.error.checkId,
          code: result.error.code,
        },
      });
      throw new Error(result.error.message);
    }

    this.updateServerState({
      startupToolchain: result.value,
    });
    this.logger.info("Startup toolchain ready", {
      fields: {
        sessionId: serverState.sessionId,
        spriteName,
        provider: providerId,
        contractHash: result.value.contractHash,
        checkCount: result.value.results.length,
      },
    });
  }

  /**
   * Clones the repository onto the sprite and configures git remotes.
   * Assumes the sprite is already created and the network policy is set.
   */
  private async cloneRepo(spriteName: string): Promise<void> {
    const clientState = this.getClientState();
    const serverState = this.getServerState();
    const repoFullName = clientState.repoFullName!;
    const sessionId = serverState.sessionId!;

    const sprite = new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
      createLogger("sprite-websocket.session.ts"),
    );

    const proxyBaseUrl = `${this.env.WORKER_URL}/git-proxy/${sessionId}`;
    const cloneUrl = `${proxyBaseUrl}/github.com/${repoFullName}.git`;
    const githubRemoteUrl = `https://github.com/${repoFullName}.git`;

    // Check if the repo is already cloned (sprite may be persistent)
    const isCloned = await sprite.execWs(
      `test -d ${WORKSPACE_DIR}/.git && echo 'exists' || echo 'empty'`,
      {},
    );
    if (isCloned.stdout.includes("exists")) {
      this.logger.info("Repo already cloned on sprite", {
        fields: { repoFullName, spriteName },
      });
    } else {
      this.logger.info("Cloning repo on sprite", {
        fields: { repoFullName, spriteName },
      });
      await sprite.execWs(`mkdir -p ${WORKSPACE_DIR}`, {});

      // Fetch a read-only token scoped to contents:read for the initial clone
      const cloneTokenResult =
        await this.githubTokenProvider.getReadOnlyTokenForRepo(repoFullName);
      if (!cloneTokenResult.ok) {
        throw new Error(cloneTokenResult.error.message);
      }
      const cloneToken = cloneTokenResult.value;
      const basicAuth = btoa(`x-access-token:${cloneToken}`);

      const cloneStart = Date.now();
      const baseBranch = sanitizeGitBranchName(clientState.baseBranch);
      const branchFlag = baseBranch ? `--branch ${shellQuote(baseBranch)} ` : "";
      const cloneCommand = [
        `git -c http.extraHeader="Authorization: Basic ${basicAuth}" clone`,
        "--single-branch",
        `${branchFlag}${shellQuote(githubRemoteUrl)}`,
        shellQuote(WORKSPACE_DIR),
      ].join(" ");
      const cloneResult = await sprite.execWs(cloneCommand, {});
      this.logger.info("Clone completed", {
        fields: {
          durationSeconds: Number(
            ((Date.now() - cloneStart) / 1000).toFixed(1),
          ),
          exitCode: cloneResult.exitCode,
          stderr: cloneResult.stderr.slice(0, 500),
        },
      });
      if (cloneResult.exitCode !== 0) {
        throw new Error(
          `Clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`,
        );
      }
    }

    // Detect the base branch (whatever branch the clone checked out)
    const branchResult = await sprite.execWs(
      `cd ${WORKSPACE_DIR} && git rev-parse --abbrev-ref HEAD`,
      {},
    );
    const actualBaseBranch = sanitizeGitBranchName(branchResult.stdout) ?? "main";
    const configuredBaseBranch = sanitizeGitBranchName(clientState.baseBranch);
    if (configuredBaseBranch && actualBaseBranch !== configuredBaseBranch) {
      this.logger.warn("Base branch does not match actual base branch", {
        fields: {
          configuredBaseBranch,
          actualBaseBranch,
        },
      });
    }
    if (actualBaseBranch !== configuredBaseBranch) {
      this.updatePartialState({ baseBranch: actualBaseBranch });
    }

    // The session_connector task is blocking and ordered before this one
    // (including back-filled pre-connector runs), so a missing gateway base
    // is an invariant violation, not a fallback case.
    const connectorGatewayBase = this.getSessionConnectorGatewayBase();
    if (!connectorGatewayBase) {
      throw new Error("Session connector gateway base is missing");
    }
    const helperPath = `/home/sprite/.local/bin/mm-git-credential-${sessionId}`;
    const mintUrl =
      `${connectorGatewayBase}/internal/session/${sessionId}/git-token`;
    const helperSource = buildGitCredentialHelper({
      remoteUrl: cloneUrl,
      mintUrl,
    });
    const helperBase64 = btoa(helperSource);
    const gitTokenSetupResult = await sprite.execWs(
      dedent`
      set -e
      mkdir -p /home/sprite/.local/bin
      echo ${shellQuote(helperBase64)} | base64 -d > ${shellQuote(helperPath)}
      chmod 700 ${shellQuote(helperPath)}
      cd ${WORKSPACE_DIR}
      git remote set-url origin ${shellQuote(cloneUrl)}
      git remote set-url --push origin ${shellQuote(cloneUrl)}
      git config user.email "agent@mymachines.dev"
      git config user.name "My Machines"
      git config --unset-all http.extraHeader || true
      git config --unset-all "http.${proxyBaseUrl}/.extraHeader" || true
      git config --unset-all credential.helper || true
      git config credential.helper ""
      git config --add ${shellQuote(`credential.${cloneUrl}.helper`)} ${shellQuote(helperPath)}
      git config ${shellQuote(`credential.${cloneUrl}.username`)} x-ephemeral-git-token
      git config credential.useHttpPath true
      git config ${shellQuote(`http.${proxyBaseUrl}/.proactiveAuth`)} basic
    `,
      {},
    );
    if (gitTokenSetupResult.exitCode !== 0) {
      throw new Error(
        `Ephemeral git token setup failed (exit ${gitTokenSetupResult.exitCode}): `
        + gitTokenSetupResult.stderr,
      );
    }
    this.retireGitProxySecret();
    this.updateServerState({ gitAuthMode: "ephemeral_token" });
  }

  private async applyFinalNetworkPolicy(spriteName: string): Promise<void> {
    const environmentSnapshot = this.getEnvironmentSnapshot();
    const providerId = this.getClientState().agentSettings.provider;
    const sprite = new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
      createLogger("sprite-websocket.session.ts"),
    );
    const workerHostname = new URL(this.env.WORKER_URL).hostname;

    await sprite.setNetworkPolicy(
      buildFinalNetworkPolicy({
        workerHostname,
        providerId,
        network: environmentSnapshot.network,
        connectorGatewayHostname: this.connectorGatewayHostname(),
      }),
    );
  }
}

function buildGitCredentialHelper(input: {
  remoteUrl: string;
  mintUrl: string;
}): string {
  const remote = new URL(input.remoteUrl);
  return `#!/usr/bin/env bun
const operation = process.argv[2] ?? "";
const input = await Bun.stdin.text();
if (operation !== "get") process.exit(0);
const values = Object.fromEntries(input.trim().split("\\n").filter(Boolean).map((line) => {
  const separator = line.indexOf("=");
  return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
}));
if (values.protocol !== ${JSON.stringify(remote.protocol.slice(0, -1))}
  || values.host !== ${JSON.stringify(remote.host)}
  || values.path !== ${JSON.stringify(remote.pathname.slice(1))}) process.exit(0);
let response;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    response = await fetch(${JSON.stringify(input.mintUrl)}, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (response.ok || response.status < 500) break;
  } catch {}
  if (attempt < 2) await Bun.sleep(100 * (attempt + 1));
}
if (!response?.ok) {
  process.stderr.write("Git credential mint failed\\n");
  process.exit(1);
}
const body = await response.json();
if (typeof body?.token !== "string" || !body.token || !Number.isInteger(body.expiresAt)) {
  process.stderr.write("Git credential mint returned an invalid response\\n");
  process.exit(1);
}
process.stdout.write("username=x-ephemeral-git-token\\npassword=" + body.token + "\\n\\n");
`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the setup task's output metadata; full output lives in the setup-output store. */
function buildSetupScriptOutput(
  exitCode: number | null,
  outputInfo: SetupOutputFinishResult | undefined,
): SessionSetupTaskOutput {
  return {
    exitCode,
    truncated: outputInfo?.truncated ?? false,
    stdoutLength: outputInfo?.stdoutLength ?? 0,
    stderrLength: outputInfo?.stderrLength ?? 0,
  };
}

function hasRetryableFailedProvisionTask(
  setupRun: SessionSetupRun,
): boolean {
  return setupRun.tasks.some(isRetryableFailedProvisionTask);
}

function isRetryableFailedProvisionTask(
  task: SessionSetupTask,
): boolean {
  return task.status === "failed" && task.canRetry;
}

function buildSkippedSetupScriptSkipReason(
  snapshot: SessionEnvironmentSnapshot,
): StartupScriptSetupTaskSkipReason {
  if (snapshot.sourceEnvironmentId) {
    return {
      kind: "no_script",
      environmentId: snapshot.sourceEnvironmentId,
      environmentName: snapshot.sourceEnvironmentName,
    };
  }

  return {
    kind: "no_environment",
    repoId: snapshot.repoId,
  };
}
