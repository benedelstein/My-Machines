import type { Logger } from "@repo/shared";

/**
 * No-op logger for tests. Pass spies for the levels a test asserts on:
 * `createTestLogger({ warn: warnSpy })`.
 */
export function createTestLogger(
  spies: Partial<Pick<Logger, "debug" | "info" | "warn" | "error">> = {},
): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    ...spies,
    scope() {
      return this;
    },
  } as Logger;
}
