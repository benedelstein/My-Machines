import type {
  DomainError,
  Logger,
  ProviderId,
  Result,
} from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { StartupToolchainCheckResult } from "@/shared/types/startup-toolchain";

export const STARTUP_TOOLCHAIN_DOMAIN = "startup_toolchain";

export type StartupToolchainError = DomainError<
  typeof STARTUP_TOOLCHAIN_DOMAIN,
  "CHECK_FAILED",
  {
    provider?: ProviderId;
    checkId: string;
    requiredVersion?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    cause?: string;
  }
>;

export interface StartupToolchainCheckInput {
  sprite: WorkersSpriteClient;
}

export interface StartupToolchainCheck {
  id: string;
  contract: Record<string, unknown>;
  ensureReady(
    _input: StartupToolchainCheckInput,
  ): Promise<Result<StartupToolchainCheckResult, StartupToolchainError>>;
}

export interface StartupToolchainDeps {
  logger: Logger;
  codexMinVersion?: string;
}
