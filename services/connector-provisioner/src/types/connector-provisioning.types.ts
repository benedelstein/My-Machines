import type { AccessPolicy, SpritesRestErrorCode } from "@repo/sprites-client";
import type {
  CleanupStatus,
  ConnectorProvisioningDurations,
  DashboardShapeDiagnostics,
} from "../connectors.schema";
import type { DashboardCreateErrorCode, DashboardOperation } from "./dashboard.types";

/** Provisioning step a mint failed in. */
export type ProvisioningStage =
  | "dashboard_create"
  | "list_after"
  | "scope"
  | "verify"
  | "cleanup";

export type ConnectorProvisionerErrorCode =
  | DashboardCreateErrorCode
  | SpritesRestErrorCode
  | "connector_reconciliation_failed"
  | "orphan_reconciliation_required"
  | "policy_verification_failed"
  | "cleanup_failed";

export interface ConnectorProvisionerError {
  code: ConnectorProvisionerErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  dashboardOperation?: DashboardOperation;
  dashboardShape?: DashboardShapeDiagnostics;
  message: string;
  cleanup: CleanupStatus;
  durations: ConnectorProvisioningDurations;
}

/**
 * Why a connector could not be confirmed deleted. `cause` keeps the underlying
 * Sprites REST failure, or records that the connector was still listed after
 * the REST delete reported success.
 */
export interface ConnectorCleanupError {
  code: "cleanup_failed";
  retryable: boolean;
  cause: SpritesRestErrorCode | "connector_still_present";
}

export interface MintConnectorResult {
  name: string;
  gatewayConnectionId: string;
  detailId?: string;
  accessPolicy: AccessPolicy;
  durations: ConnectorProvisioningDurations;
}
