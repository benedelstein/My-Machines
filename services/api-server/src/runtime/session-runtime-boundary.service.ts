import {
  type Logger,
  type Result,
  failure,
  success,
} from "@repo/shared";
import type {
  ClaimedTurn,
  PreparedChatMessage,
  SessionChatDispatchService,
} from "@/modules/session-agent/services/session-chat-dispatch.service";
import type { SessionProvisionService } from
  "@/modules/session-agent/services/session-provision.service";
import type { HandleInitResult } from "@/shared/types/session-agent";
import {
  RuntimeBoundaryMutex,
  type RuntimeBoundaryLease,
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

interface SessionRuntimeState {
  initialized: boolean;
  setupComplete: boolean;
  hasActiveOrPendingTurn: boolean;
}

type RuntimeProvisioner = Pick<SessionProvisionService, "ensureProvisioned">;

type RuntimeTurnDispatcher = Pick<
  SessionChatDispatchService,
  | "recoverInterruptedClaim"
  | "claimPendingMessage"
  | "claimPreparedMessage"
  | "spawnClaimedTurn"
>;

interface SessionRuntimeBoundaryServiceDeps {
  logger: Logger;
  provisioner: RuntimeProvisioner;
  turnDispatcher: RuntimeTurnDispatcher;
  readState: () => SessionRuntimeState;
  getInitializationPromise: () => Promise<HandleInitResult> | null;
}

/** Owns the selective mutex interval around readiness and turn claims. */
export class SessionRuntimeBoundaryService {
  private readonly mutex = new RuntimeBoundaryMutex();

  constructor(private readonly deps: SessionRuntimeBoundaryServiceDeps) {}

  /** Runs readiness, claims a pending initial turn, then dispatches after release. */
  async ensureReady(): Promise<EnsureReadyResult> {
    const admission = await this.mutex.runExclusive(async (lease) => {
      const readiness = await this._ensureReady(lease);
      const claimedTurn = readiness.ok && readiness.value.outcome === "ready"
        ? this.deps.turnDispatcher.claimPendingMessage()
        : null;
      return { readiness, claimedTurn };
    });

    if (admission.claimedTurn) {
      const dispatchResult = await this.deps.turnDispatcher.spawnClaimedTurn(
        admission.claimedTurn,
      );
      if (!dispatchResult.ok) {
        this.deps.logger.error("Failed to dispatch pending message", {
          fields: { code: dispatchResult.error.code },
          error: dispatchResult.error.message,
        });
      }
    }
    return admission.readiness;
  }

  /**
   * Runs readiness stages while this service owns the runtime boundary.
   * The lease makes calling these stages without mutex ownership a compile error.
   */
  private async _ensureReady(
    _lease: RuntimeBoundaryLease,
  ): Promise<EnsureReadyResult> {
    if (!this.deps.readState().initialized) {
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

    this.deps.turnDispatcher.recoverInterruptedClaim();
    try {
      await this.deps.provisioner.ensureProvisioned();
    } catch (error) {
      return failure({
        code: "PROVISIONING_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return success({
      outcome: this.deps.readState().setupComplete
        ? "ready"
        : "setup_incomplete",
    });
  }

  /** Claims a prepared direct chat without yielding after readiness succeeds. */
  async admitPreparedTurn(
    prepared: PreparedChatMessage,
  ): Promise<Result<ClaimedTurn, ChatAdmissionError>> {
    return this.mutex.runExclusive(async (lease) => {
      const readiness = await this._ensureReady(lease);
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
      if (this.deps.readState().hasActiveOrPendingTurn) {
        return failure({
          code: "TURN_CONFLICT",
          message: "Agent is already handling a message",
        });
      }
      return success(this.deps.turnDispatcher.claimPreparedMessage(prepared));
    });
  }
}
