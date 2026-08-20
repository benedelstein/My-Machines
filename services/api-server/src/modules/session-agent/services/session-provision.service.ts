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
  type SpriteLifecycleClient,
  type SpriteResponse,
  type WorkersSpriteClient,
} from "@repo/sprites-client";
import { sha256 } from "@/shared/utils/crypto";
import { sanitizeGitBranchName, shellQuote } from "@/shared/utils/git-branch";
import type { GitHubAppResult } from "@/shared/types/github";
import EPHEMERAL_GIT_CREDENTIAL_HELPER from "@repo/vm-agent/dist/git-credential-helper.bundle.js";
import type { ServerState } from
  "../types/server-state.types";
import type { RuntimeBoundaryLease } from "../types/runtime-boundary.types";
import type { SpriteNetworkPolicyContract } from
  "../types/runtime-migration-adopters.types";
import type { RuntimeMigrationCoordinatorResult } from "../types/runtime-migration.types";
import type { RuntimeMigrationId } from
  "./runtime-migration/runtime-migration-registry.service";
import { buildSessionSpriteLabels } from "./session-connector.service";
import { isTerminalSetupTask } from "./session-setup-run.service";
import { STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID } from
  "./runtime-migration/startup-toolchain-runtime-migration.service";
import { SESSION_CONNECTOR_RUNTIME_MIGRATION_ID } from
  "./runtime-migration/session-connector-runtime-migration.service";
import { GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID } from
  "./runtime-migration/git-ephemeral-token-runtime-migration.service";
import { NETWORK_POLICY_RUNTIME_MIGRATION_ID } from
  "./runtime-migration/network-policy-runtime-migration.service";
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
  createSpriteClient: (spriteName: string) => WorkersSpriteClient;

  getServerState: () => ServerState;
  getClientState: () => ClientState;
  getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  updateServerState: (partial: Partial<ServerState>) => void;
  updatePartialState: (partial: ProvisionClientStateUpdate) => void;
  synthesizeStatus: () => SessionStatus;
  retireGitProxySecret: () => void;
  getSessionConnectorGatewayBase: () => string | null;
  discardFreshSpriteSnapshot?: () => void;
  onSpriteCreated?: (sprite: SpriteResponse) => void;
  ensureRuntimeMigration: (
    migrationId: RuntimeMigrationId,
    lease: RuntimeBoundaryLease,
  ) => Promise<RuntimeMigrationCoordinatorResult>;
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
  private readonly createSpriteClient: (spriteName: string) => WorkersSpriteClient;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly getEnvironmentSnapshot: () => SessionEnvironmentSnapshot;
  private readonly updateServerState: SessionProvisionServiceDeps["updateServerState"];
  private readonly updatePartialState: SessionProvisionServiceDeps["updatePartialState"];
  private readonly synthesizeStatus: () => SessionStatus;
  private readonly retireGitProxySecret: () => void;
  private readonly getSessionConnectorGatewayBase:
    SessionProvisionServiceDeps["getSessionConnectorGatewayBase"];
  private readonly discardFreshSpriteSnapshot: () => void;
  private readonly onSpriteCreated: (sprite: SpriteResponse) => void;
  private readonly ensureRuntimeMigration: SessionProvisionServiceDeps["ensureRuntimeMigration"];
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
    this.createSpriteClient = deps.createSpriteClient;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.getEnvironmentSnapshot = deps.getEnvironmentSnapshot;
    this.updateServerState = deps.updateServerState;
    this.updatePartialState = deps.updatePartialState;
    this.synthesizeStatus = deps.synthesizeStatus;
    this.retireGitProxySecret = deps.retireGitProxySecret;
    this.getSessionConnectorGatewayBase = deps.getSessionConnectorGatewayBase;
    this.discardFreshSpriteSnapshot = deps.discardFreshSpriteSnapshot ?? (() => {});
    this.onSpriteCreated = deps.onSpriteCreated ?? (() => {});
    this.ensureRuntimeMigration = deps.ensureRuntimeMigration;
    this.githubTokenProvider = deps.githubTokenProvider;
    this.setupReporter = deps.setupReporter;
    this.setupOutputCollector = deps.setupOutputCollector;
    this.startupScriptService = new SessionStartupScriptService(this.logger);
  }

  /**
   * Ensures the sprite is created and the repo is cloned. Safe to call
   * concurrently — all callers share one in-flight promise.
   */
  ensureProvisioned(lease: RuntimeBoundaryLease): Promise<void> {
    if (this.ensureProvisionedPromise) {
      return this.ensureProvisionedPromise;
    }
    this.ensureProvisionedPromise = this._provision(lease).finally(() => {
      this.ensureProvisionedPromise = null;
    });
    return this.ensureProvisionedPromise;
  }

  private async _provision(lease: RuntimeBoundaryLease): Promise<void> {
    this.discardFreshSpriteSnapshot();
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
            await this.ensureCloudContainerTask(lease);
            break;
          case "session_connector":
            await this.ensureSessionConnectorTask(lease);
            break;
          case "repository":
            await this.ensureRepositoryTask(
              this.requireSpriteName(),
              lease,
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
            await this.ensureNetworkPolicyTask(lease);
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

  private async ensureCloudContainerTask(lease: RuntimeBoundaryLease): Promise<void> {
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
      this.onSpriteCreated(spriteResponse);
      this.spriteName = spriteResponse.name;
      // For provisioning, allow network access to known-good domains.
      const sprite = this.createSpriteClient(spriteResponse.name);
      const workerHostname = new URL(this.env.WORKER_URL).hostname;
      const networkPolicy = buildBootstrapNetworkPolicy({
        workerHostname,
        connectorGatewayHostname: this.connectorGatewayHostname(),
      });
      await sprite.setNetworkPolicy(networkPolicy);
      this.updateServerState({ spriteName: this.spriteName });
    }
    // Requires the Sprite name to already be in ServerState — the migration
    // host reads it from there to build its client.
    this.requireSpriteName();
    await this.ensureTargetedMigration(STARTUP_TOOLCHAIN_RUNTIME_MIGRATION_ID, lease, "Startup toolchain");
  }

  private async ensureSessionConnectorTask(lease: RuntimeBoundaryLease): Promise<void> {
    await this.ensureTargetedMigration(
      SESSION_CONNECTOR_RUNTIME_MIGRATION_ID,
      lease,
      "Session connector",
    );
  }

  /** Gateway hostname kept reachable in restricted network modes. */
  private connectorGatewayHostname(): string {
    return new URL(this.env.SPRITES_API_URL).hostname;
  }

  private async ensureRepositoryTask(
    spriteName: string,
    lease: RuntimeBoundaryLease,
  ): Promise<void> {
    if (!this.getServerState().repoCloned) {
      await this.cloneRepo(spriteName);
      this.updateServerState({ repoCloned: true });
    }
    await this.ensureTargetedMigration(
      GIT_EPHEMERAL_TOKEN_RUNTIME_MIGRATION_ID,
      lease,
      "Ephemeral Git token cutover",
    );
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
    const sprite = this.createSpriteClient(spriteName);

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

  private async ensureNetworkPolicyTask(lease: RuntimeBoundaryLease): Promise<void> {
    await this.ensureTargetedMigration(
      NETWORK_POLICY_RUNTIME_MIGRATION_ID,
      lease,
      "Network policy",
    );
  }

  private requireSpriteName(): string {
    const spriteName = this.spriteName;
    if (!spriteName) {
      throw new Error("Sprite name is missing");
    }
    return spriteName;
  }

  /**
   * Clones the repository onto the sprite and configures git remotes.
   * Assumes the sprite is already created and the network policy is set.
   */
  private async cloneRepo(spriteName: string): Promise<void> {
    const clientState = this.getClientState();
    const repoFullName = clientState.repoFullName!;

    const sprite = this.createSpriteClient(spriteName);

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

  }

  /** Reconciles and locally verifies the historical ephemeral-token Git cutover. */
  async reconcileGitEphemeralTokenCutover(): Promise<void> {
    const spriteName = this.getServerState().spriteName;
    const sessionId = this.getServerState().sessionId;
    const repoFullName = this.getClientState().repoFullName;
    if (!spriteName || !sessionId || !repoFullName) {
      throw new Error("Git cutover prerequisites are missing");
    }
    if (!this.getServerState().repoCloned) {
      throw new Error("Repository must be cloned before Git cutover");
    }
    const sprite = this.createSpriteClient(spriteName);
    const proxyBaseUrl = `${this.env.WORKER_URL}/git-proxy/${sessionId}`;
    const cloneUrl = `${proxyBaseUrl}/github.com/${repoFullName}.git`;
    const connectorGatewayBase = this.getSessionConnectorGatewayBase();
    if (!connectorGatewayBase) {
      throw new Error("Session connector gateway base is missing");
    }
    const helperPath = `/home/sprite/.local/bin/mm-git-credential-${sessionId}`;
    const mintUrl =
      `${connectorGatewayBase}/internal/session/${sessionId}/git-token`;
    // The leading ! makes Git run the quoted helper command through the shell.
    // Without it, Git treats the leading quote as part of a helper name.
    const helperCommand = `!${[helperPath, cloneUrl, mintUrl]
      .map(shellQuote)
      .join(" ")}`;
    const helperHash = await sha256(EPHEMERAL_GIT_CREDENTIAL_HELPER);
    await sprite.writeFile(
      helperPath,
      EPHEMERAL_GIT_CREDENTIAL_HELPER,
      { mode: "0700" },
    );
    const gitTokenSetupResult = await sprite.execWs(
      dedent`
      set -e
      cd ${WORKSPACE_DIR}
      git remote set-url origin ${shellQuote(cloneUrl)}
      git remote set-url --push origin ${shellQuote(cloneUrl)}
      git config user.email "agent@mymachines.dev"
      git config user.name "My Machines"
      git config --unset-all http.extraHeader || true
      git config --unset-all "http.${proxyBaseUrl}/.extraHeader" || true
      git config --unset-all credential.helper || true
      git config credential.helper ""
      git config --add ${shellQuote(`credential.${cloneUrl}.helper`)} ${shellQuote(helperCommand)}
      git config ${shellQuote(`credential.${cloneUrl}.username`)} x-ephemeral-git-token
      git config credential.useHttpPath true
      git config ${shellQuote(`http.${proxyBaseUrl}/.proactiveAuth`)} basic
      test "$(git remote get-url origin)" = ${shellQuote(cloneUrl)}
      test "$(git remote get-url --push origin)" = ${shellQuote(cloneUrl)}
      test "$(git config --get ${shellQuote(`credential.${cloneUrl}.helper`)})" = ${shellQuote(helperCommand)}
      test "$(git config --get ${shellQuote(`credential.${cloneUrl}.username`)})" = x-ephemeral-git-token
      test "$(git config --get credential.useHttpPath)" = true
      test "$(git config --get ${shellQuote(`http.${proxyBaseUrl}/.proactiveAuth`)})" = basic
      test "$(sha256sum ${shellQuote(helperPath)} | cut -d ' ' -f 1)" = ${shellQuote(helperHash)}
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

  /** Applies the exact policy prepared by the runtime migration. */
  async reconcileNetworkPolicy(contract: SpriteNetworkPolicyContract): Promise<void> {
    const spriteName = this.getServerState().spriteName;
    if (!spriteName) {
      throw new Error("Sprite name is missing");
    }
    const sprite = this.createSpriteClient(spriteName);
    const desiredRules = contract.rules.map((rule) => ({ ...rule }));
    await sprite.setNetworkPolicy(desiredRules);
    this.updateServerState({ finalNetworkPolicyApplied: true });
  }

  private async ensureTargetedMigration(
    migrationId: RuntimeMigrationId,
    lease: RuntimeBoundaryLease,
    label: string,
  ): Promise<void> {
    const migration = await this.ensureRuntimeMigration(migrationId, lease);
    if (!migration.ok) {
      throw new Error(migration.error.message);
    }
    if (migration.value.outcome === "deferred_active_turn") {
      throw new Error(`${label} migration deferred during setup`);
    }
  }
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
