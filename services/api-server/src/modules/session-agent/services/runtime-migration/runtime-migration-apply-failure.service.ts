import type { Logger } from "@repo/shared";

const SPRITES_ERROR_CODES = [
  "sprites_authentication_failed",
  "sprites_rate_limited",
  "sprites_request_failed",
  "sprites_response_invalid",
] as const;

function providerStatusCategory(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return "provider_authentication_failed";
  }
  if (statusCode === 404) {
    return "provider_not_found";
  }
  if (statusCode === 409) {
    return "provider_conflict";
  }
  if (statusCode === 429) {
    return "provider_rate_limited";
  }
  return statusCode >= 500 ? "provider_unavailable" : "provider_rejected";
}

/** Returns a secret-safe category without retaining provider response text. */
export function runtimeMigrationApplyFailureCategory(error: unknown): string {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return providerStatusCategory(statusCode);
    }
  }
  if (error instanceof Error) {
    const spritesCode = SPRITES_ERROR_CODES.find((code) => error.message.includes(code));
    if (spritesCode) {
      return spritesCode;
    }
    if (/verification|readback/u.test(error.message)) {
      return "verification_failed";
    }
    if (/missing|must be cloned|prerequisite/u.test(error.message)) {
      return "prerequisite_failed";
    }
  }
  return "operation_failed";
}

export function logRuntimeMigrationApplyFailure(
  logger: Logger,
  migrationId: string,
  error: unknown,
): void {
  logger.warn("Runtime migration adopter failed", {
    fields: {
      migrationId,
      cause: runtimeMigrationApplyFailureCategory(error),
    },
  });
}
