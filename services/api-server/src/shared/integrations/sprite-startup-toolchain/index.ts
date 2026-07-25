import type { Logger, ProviderId, Result } from "@repo/shared";
import { failure, success } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { sha256 } from "@/shared/utils/crypto";
import type {
  StartupToolchainCheckpoint,
} from "@/shared/types/startup-toolchain";
import { getCommonStartupToolchainChecks } from "./checks/common";
import { getClaudeStartupToolchainChecks } from "./providers/claude";
import { getOpenAICodexStartupToolchainChecks } from "./providers/openai-codex";
import type {
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

async function buildStartupToolchainContractHash(
  providerId: ProviderId,
  checks: StartupToolchainCheck[],
): Promise<string> {
  return sha256(JSON.stringify({
    providerId,
    checks: checks.map((check) => check.contract),
  }));
}

export async function ensureSpriteStartupToolchain(args: {
  providerId: ProviderId;
  sprite: WorkersSpriteClient;
  checkpoint: StartupToolchainCheckpoint | null;
  logger: Logger;
  codexMinVersion?: string;
}): Promise<Result<StartupToolchainCheckpoint, StartupToolchainError>> {
  const checks = [
    ...getCommonStartupToolchainChecks(),
    ...getProviderStartupToolchainChecks(args.providerId, {
      logger: args.logger,
      codexMinVersion: args.codexMinVersion,
    }),
  ];
  const contractHash = await buildStartupToolchainContractHash(
    args.providerId,
    checks,
  );
  if (args.checkpoint?.contractHash === contractHash) {
    args.logger.info("Startup toolchain checkpoint is current", {
      fields: {
        provider: args.providerId,
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
        provider: args.providerId,
        contractHash,
        checkId: check.id,
      },
    });
    const result = await check.ensureReady({ sprite: args.sprite });
    if (!result.ok) {
      args.logger.warn("Startup toolchain check returned failure", {
        fields: {
          provider: args.providerId,
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
      provider: args.providerId,
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
