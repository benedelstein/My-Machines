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

export type StartupToolchainContractValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: StartupToolchainContractValue }
  | readonly StartupToolchainContractValue[];

export interface StartupToolchainContract {
  readonly [key: string]: StartupToolchainContractValue;
  readonly contractSchema: 1;
  readonly providerId: ProviderId;
  readonly checks: readonly StartupToolchainContractValue[];
}

export interface StartupToolchainCheck {
  id: string;
  /** Stable desired inputs whose changes require this check to run again. */
  contract: { readonly [key: string]: StartupToolchainContractValue };
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
