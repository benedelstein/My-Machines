import {
  dedent,
  type ClientState,
  type Logger,
} from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import EPHEMERAL_GIT_CREDENTIAL_HELPER from
  "@repo/vm-agent/dist/git-credential-helper.bundle.js";
import type { Env } from "@/shared/types";
import type { GitHubAppResult } from "@/shared/types/github";
import { sha256 } from "@/shared/utils/crypto";
import { sanitizeGitBranchName, shellQuote } from "@/shared/utils/git-branch";
import type { ServerState } from "../types/server-state.types";

const WORKSPACE_DIR = "/home/sprite/workspace";

type GitRepoClientStateUpdate = Partial<Pick<ClientState, "baseBranch">>;

export interface SessionGitRepoServiceDeps {
  logger: Logger;
  env: Pick<Env, "WORKER_URL">;
  createSpriteClient: (spriteName: string) => WorkersSpriteClient;
  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updateRepoCloned: (repoCloned: boolean) => void;
  updateGitAuthMode: (gitAuthMode: ServerState["gitAuthMode"]) => void;
  updatePartialState: (partial: GitRepoClientStateUpdate) => void;
  retireGitProxySecret: () => void;
  getSessionConnectorGatewayBase: () => string | null;
  githubTokenProvider: {
    getReadOnlyTokenForRepo(
      repoFullName: string,
    ): Promise<GitHubAppResult<string>>;
  };
}

/** Owns the session repository clone and its durable Git configuration. */
export class SessionGitRepoService {
  private readonly logger: Logger;
  private readonly env: Pick<Env, "WORKER_URL">;
  private readonly createSpriteClient: (spriteName: string) => WorkersSpriteClient;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly updateRepoCloned: SessionGitRepoServiceDeps["updateRepoCloned"];
  private readonly updateGitAuthMode: SessionGitRepoServiceDeps["updateGitAuthMode"];
  private readonly updatePartialState: SessionGitRepoServiceDeps["updatePartialState"];
  private readonly retireGitProxySecret: () => void;
  private readonly getSessionConnectorGatewayBase:
    SessionGitRepoServiceDeps["getSessionConnectorGatewayBase"];
  private readonly githubTokenProvider: SessionGitRepoServiceDeps["githubTokenProvider"];

  constructor(deps: SessionGitRepoServiceDeps) {
    this.logger = deps.logger.scope("session-git-repo-service");
    this.env = deps.env;
    this.createSpriteClient = deps.createSpriteClient;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.updateRepoCloned = deps.updateRepoCloned;
    this.updateGitAuthMode = deps.updateGitAuthMode;
    this.updatePartialState = deps.updatePartialState;
    this.retireGitProxySecret = deps.retireGitProxySecret;
    this.getSessionConnectorGatewayBase = deps.getSessionConnectorGatewayBase;
    this.githubTokenProvider = deps.githubTokenProvider;
  }

  /** Ensures the repository clone exists and records its durable checkpoint. */
  async ensureCloned(spriteName: string): Promise<void> {
    if (this.getServerState().repoCloned) {
      return;
    }
    await this.cloneRepo(spriteName);
    this.updateRepoCloned(true);
  }

  /** Reconciles and locally verifies the historical ephemeral-token Git cutover.
   * see docs/github-app-auth.md for more details on why we use a git credential helper.
   */
  async reconcileEphemeralTokenCutover(): Promise<void> {
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
    this.retireGitProxySecret(); // legacy
    this.updateGitAuthMode("ephemeral_token");
  }

  /** Clones the repository after the Sprite and bootstrap network are ready. */
  private async cloneRepo(spriteName: string): Promise<void> {
    const clientState = this.getClientState();
    const repoFullName = clientState.repoFullName!;
    const sprite = this.createSpriteClient(spriteName);
    const githubRemoteUrl = `https://github.com/${repoFullName}.git`;

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
}
