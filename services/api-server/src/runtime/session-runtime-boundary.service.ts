import {
  type Logger,
  type Result,
  failure,
  success,
} from "@repo/shared";
import type {
  ChatDispatchError,
  ClaimedTurn,
  PreparedChatMessage,
} from "@/modules/session-agent/services/session-chat-dispatch.service";
import type { HandleInitResult } from "@/shared/types/session-agent";
import type {
  RuntimeBoundaryLease,
  RuntimeBoundaryMutex,
} from "./runtime-boundary-mutex";

export type EnsureReadyOutcome =
  | { outcome: "ready" }
  | { outcome: "setup_incomplete" };

export type EnsureReadyError = {
  code:
    | "SESSION_NOT_INITIALIZED"
    | "INITIALIZATION_FAILED"
    | "PROVISIONING_FAILED";
  message: string;
};

export type EnsureReadyResult = Result<EnsureReadyOutcome, EnsureReadyError>;

type ChatAdmissionError = {
  code: "READINESS_FAILED" | "TURN_CONFLICT";
  message: string;
};

export interface SessionRuntimeBoundaryServiceDeps {
  logger: Logger;
  mutex: RuntimeBoundaryMutex;
  isInitialized: () => boolean;
  getInitializationPromise: () => Promise<HandleInitResult> | null;
  ensureReadyUnderLease: (lease: RuntimeBoundaryLease) => Promise<EnsureReadyResult>;
  ensureProvisioned: () => Promise<void>;
  isSetupComplete: () => boolean;
  hasActiveOrPendingTurn: () => boolean;
  recoverInterruptedClaim: () => string | null;
  claimPendingMessage: () => ClaimedTurn | null;
  claimPreparedMessage: (prepared: PreparedChatMessage) => ClaimedTurn;
  spawnClaimedTurn: (
    claimedTurn: ClaimedTurn,
  ) => Promise<Result<void, ChatDispatchError>>;
}

/** Owns the selective mutex interval around readiness and turn claims. */
export class SessionRuntimeBoundaryService {
  constructor(private readonly deps: SessionRuntimeBoundaryServiceDeps) {}

  /** Runs readiness, claims a pending initial turn, then dispatches after release. */
  async ensureReady(): Promise<EnsureReadyResult> {
    const admission = await this.deps.mutex.runExclusive(async (lease) => {
      const readiness = await this.deps.ensureReadyUnderLease(lease);
      const claimedTurn = readiness.ok && readiness.value.outcome === "ready"
        ? this.deps.claimPendingMessage()
        : null;
      return { readiness, claimedTurn };
    });

    if (admission.claimedTurn) {
      const dispatchResult = await this.deps.spawnClaimedTurn(admission.claimedTurn);
      if (!dispatchResult.ok) {
        this.deps.logger.error("Failed to dispatch pending message", {
          fields: { code: dispatchResult.error.code },
          error: dispatchResult.error.message,
        });
      }
    }
    return admission.readiness;
  }

  /** Runs readiness stages while the caller owns the runtime boundary. */
  async runReadinessStages(
    _lease: RuntimeBoundaryLease,
  ): Promise<EnsureReadyResult> {
    if (!this.deps.isInitialized()) {
      const initResult = await this.deps.getInitializationPromise();
      if (!initResult) {
        return failure({
          code: "SESSION_NOT_INITIALIZED",
          message: "Session is not initialized",
        });
      }
      if (!initResult.ok) {
        return failure({
          code: "INITIALIZATION_FAILED",
          message: initResult.error.message,
        });
      }
    }

    this.deps.recoverInterruptedClaim();
    try {
      await this.deps.ensureProvisioned();
    } catch (error) {
      return failure({
        code: "PROVISIONING_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return success({
      outcome: this.deps.isSetupComplete() ? "ready" : "setup_incomplete",
    });
  }

  /** Claims a prepared direct chat without yielding after readiness succeeds. */
  async claimPreparedMessage(
    prepared: PreparedChatMessage,
  ): Promise<Result<ClaimedTurn, ChatAdmissionError>> {
    return this.deps.mutex.runExclusive(async (lease) => {
      const readiness = await this.deps.ensureReadyUnderLease(lease);
      if (!readiness.ok) {
        return failure({
          code: "READINESS_FAILED",
          message: readiness.error.message,
        });
      }
      if (readiness.value.outcome !== "ready") {
        return failure({
          code: "READINESS_FAILED",
          message: "Session setup is not complete",
        });
      }
      if (this.deps.hasActiveOrPendingTurn()) {
        return failure({
          code: "TURN_CONFLICT",
          message: "Agent is already handling a message",
        });
      }
      return success(this.deps.claimPreparedMessage(prepared));
    });
  }
}
