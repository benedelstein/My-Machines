import { failure, success } from "@repo/shared";
import type { ExecResult } from "@repo/sprites-client";
import type { StartupToolchainError } from "./types";
import { STARTUP_TOOLCHAIN_DOMAIN } from "./types";

const MAX_OUTPUT_LENGTH = 500;

export function startupToolchainError(
  checkId: string,
  message: string,
  extra: Omit<
    StartupToolchainError,
    "domain" | "code" | "message" | "checkId"
  > = {},
): StartupToolchainError {
  return {
    domain: STARTUP_TOOLCHAIN_DOMAIN,
    code: "CHECK_FAILED",
    message,
    checkId,
    ...extra,
  };
}

export function truncateCommandOutput(
  value: string | undefined,
): string | undefined {
  if (!value) { return undefined; }
  return value.length > MAX_OUTPUT_LENGTH
    ? `${value.slice(0, MAX_OUTPUT_LENGTH)}...`
    : value;
}

export function execResultErrorFields(result: ExecResult): {
  stdout?: string;
  stderr?: string;
  exitCode: number;
} {
  return {
    stdout: truncateCommandOutput(result.stdout),
    stderr: truncateCommandOutput(result.stderr),
    exitCode: result.exitCode,
  };
}

export { failure, success };
