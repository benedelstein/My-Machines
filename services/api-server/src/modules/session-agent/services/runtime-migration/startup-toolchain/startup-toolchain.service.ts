import type { Logger, ProviderId, Result } from "@repo/shared";
import { failure, success } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { sha256 } from "@/shared/utils/crypto";
import type {
  StartupToolchainCheckpoint,
} from "@/modules/session-agent/types/startup-toolchain.types";
import { getCommonStartupToolchainChecks } from "./checks/common";
import { getClaudeStartupToolchainChecks } from "./providers/claude";
import { getOpenAICodexStartupToolchainChecks } from "./providers/openai-codex";
import type {
  PreparedStartupToolchain,
  StartupToolchainContract,
  StartupToolchainCheck,
  StartupToolchainDeps,
  StartupToolchainError,
} from "./types";

export * from "./types";
export {
  CLAUDE_CODE_STARTUP_CHECK_ID,
  MIN_CLAUDE_CODE_CLI_VERSION,
} from "./providers/claude";
export {
  OPENAI_CODEX_INSTALL_SCRIPT_URL,
  OPENAI_CODEX_STARTUP_CHECK_ID,
} from "./providers/openai-codex";

export function getProviderStartupToolchainChecks(
  providerId: ProviderId,
  deps: StartupToolchainDeps,
): StartupToolchainCheck[] {
  switch (providerId) {
    case "claude-code":
      return getClaudeStartupToolchainChecks({ logger: deps.logger });
    case "openai-codex":
      return getOpenAICodexStartupToolchainChecks({
        logger: deps.logger,
        codexMinVersion: deps.codexMinVersion,
      });
    default: {
      const exhaustiveCheck: never = providerId;
      throw new Error(`Unhandled provider: ${exhaustiveCheck}`);
    }
  }
}

/** Builds one immutable check set used for both contract hashing and apply. */
export function prepareStartupToolchain(args: {
  providerId: ProviderId;
  logger: Logger;
  codexMinVersion?: string;
}): PreparedStartupToolchain {
  const checks = [
    ...getCommonStartupToolchainChecks(),
    ...getProviderStartupToolchainChecks(args.providerId, {
      logger: args.logger,
      codexMinVersion: args.codexMinVersion,
    }),
  ];
  return {
    contract: buildStartupToolchainContract(args.providerId, checks),
    checks,
  };
}

/** Projects executable checks into their deterministic desired contract. */
export function buildStartupToolchainContract(
  providerId: ProviderId,
  checks: readonly StartupToolchainCheck[],
): StartupToolchainContract {
  return {
    contractSchema: 1,
    providerId,
    checks: checks.map((check) => check.contract),
  };
}

/** Computes the pre-runtime-migration checkpoint hash for rollout adoption. */
export async function buildLegacyStartupToolchainContractHash(
  contract: StartupToolchainContract,
): Promise<string> {
  return sha256(JSON.stringify({
    providerId: contract.providerId,
    checks: contract.checks,
  }));
}

export async function ensurePreparedSpriteStartupToolchain(args: {
  prepared: PreparedStartupToolchain;
  sprite: WorkersSpriteClient;
  checkpoint: StartupToolchainCheckpoint | null;
  logger: Logger;
}): Promise<Result<StartupToolchainCheckpoint, StartupToolchainError>> {
  const { checks, contract } = args.prepared;
  // Existing sessions may have this legacy ServerState checkpoint but no SQLite migration row yet.
  // A matching hash lets the runtime migration adopt that state without rerunning the Sprite checks.
  const contractHash = await buildLegacyStartupToolchainContractHash(contract);
  if (args.checkpoint?.contractHash === contractHash) {
    args.logger.info("Startup toolchain checkpoint is current", {
      fields: {
        provider: contract.providerId,
        contractHash,
        checkCount: checks.length,
      },
    });
    return success(args.checkpoint);
  }

  const results = [];
  for (const check of checks) {
    args.logger.info("Running startup toolchain check", {
      fields: {
        provider: contract.providerId,
        contractHash,
        checkId: check.id,
      },
    });
    const result = await check.ensureReady({ sprite: args.sprite });
    if (!result.ok) {
      args.logger.warn("Startup toolchain check returned failure", {
        fields: {
          provider: contract.providerId,
          contractHash,
          checkId: check.id,
          code: result.error.code,
        },
      });
      return failure(result.error);
    }
    results.push(result.value);
  }

  args.logger.info("Startup toolchain checks completed", {
    fields: {
      provider: contract.providerId,
      contractHash,
      checkCount: checks.length,
    },
  });

  return success({
    contractHash,
    checkedAt: Date.now(),
    results,
  });
}

/** Compatibility wrapper retained while ServerState owns the legacy checkpoint. */
export async function ensureSpriteStartupToolchain(args: {
  providerId: ProviderId;
  sprite: WorkersSpriteClient;
  checkpoint: StartupToolchainCheckpoint | null;
  logger: Logger;
  codexMinVersion?: string;
}): Promise<Result<StartupToolchainCheckpoint, StartupToolchainError>> {
  return ensurePreparedSpriteStartupToolchain({
    prepared: prepareStartupToolchain(args),
    sprite: args.sprite,
    checkpoint: args.checkpoint,
    logger: args.logger,
  });
}
