import type { AccessPolicy, SpritesRestErrorCode } from "@repo/sprites-client";

export type CleanupStatus =
  | {
    attempted: false;
    succeeded: false;
  }
  | {
    attempted: true;
    succeeded: true;
  }
  | {
    attempted: true;
    succeeded: false;
    gatewayConnectionId: string;
    error: ConnectorCleanupError;
  };

export interface ConnectorProvisioningDurations {
  createMs?: number;
  reconcileMs?: number;
  verifyMs?: number;
  cleanupMs?: number;
  totalMs: number;
}

export type ProvisioningStage =
  | "create"
  | "reconcile"
  | "verify"
  | "cleanup";

export type ConnectorProvisioningErrorCode =
  | SpritesRestErrorCode
  | "orphan_reconciliation_required"
  | "connector_verification_failed"
  | "cleanup_failed";

export interface ConnectorProvisioningError {
  code: ConnectorProvisioningErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  message: string;
  cleanup: CleanupStatus;
  durations: ConnectorProvisioningDurations;
}

export interface ConnectorCleanupError {
  code: "cleanup_failed";
  retryable: boolean;
  cause: SpritesRestErrorCode | "connector_still_present";
}

export interface MintConnectorResult {
  name: string;
  gatewayConnectionId: string;
  accessPolicy: AccessPolicy;
  durations: ConnectorProvisioningDurations;
}
