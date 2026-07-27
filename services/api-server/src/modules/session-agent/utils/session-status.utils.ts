import type { SessionSetupRun, SessionStatus } from "@repo/shared";

/**
 * Derives the client-visible session status from the setup run.
 *
 * @param args.initialized - Whether the session has completed `handleInit`.
 * @param args.setupRun - The current setup run, or null when none exists yet.
 * @returns The synthesized session status.
 */
export function synthesizeSessionStatus(args: {
  initialized: boolean;
  setupRun: SessionSetupRun | null;
}): SessionStatus {
  if (!args.initialized || !args.setupRun) {
    return "preparing";
  }
  switch (args.setupRun.status) {
    case "running":
      return "preparing";
    case "failed":
      return "setup_failed";
    case "completed":
      return "ready";
    default: {
      const exhaustiveCheck: never = args.setupRun.status;
      throw new Error(`Unhandled setup run status: ${exhaustiveCheck}`);
    }
  }
}
