import type {
  DomainError,
  Logger,
  ProviderId,
  Result,
} from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import type { StartupToolchainCheckResult } from
  "@/modules/session-agent/types/startup-toolchain.types";
import type { JsonValue } from
  "@/modules/session-agent/types/runtime-migration.types";

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

export interface StartupToolchainContract {
  readonly [key: string]: JsonValue;
  readonly contractSchema: 1;
  readonly providerId: ProviderId;
  readonly checks: readonly JsonValue[];
}

export interface StartupToolchainCheck {
  id: string;
  /** Stable desired inputs whose changes require this check to run again. */
  contract: { readonly [key: string]: JsonValue };
  ensureReady(
    _input: StartupToolchainCheckInput,
  ): Promise<Result<StartupToolchainCheckResult, StartupToolchainError>>;
}

export interface StartupToolchainDeps {
  logger: Logger;
  codexMinVersion?: string;
}

export interface PreparedStartupToolchain {
  readonly contract: StartupToolchainContract;
  readonly checks: readonly StartupToolchainCheck[];
}
