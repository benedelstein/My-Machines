import type { Result } from "@repo/shared";
import type {
  DashboardShapeDiagnostics,
  MintConnectorRequest,
} from "../connectors.schema";

export type DashboardCreateErrorCode =
  | "reauthentication_required"
  | "dashboard_drift"
  | "connection_test_failed"
  | "dashboard_browser_failed"
  | "dashboard_navigation_failed"
  | "dashboard_create_failed";

/** Browser step a dashboard failure happened in, for attribution in logs. */
export type DashboardOperation =
  | "browser_launch"
  | "context_create"
  | "page_create"
  | "goto"
  | "form_wait"
  | "shape_read"
  | "fill"
  | "connection_test"
  | "submit";

export interface DashboardCreateResult {
  detailId?: string;
  durations: {
    browserLaunchMs: number;
    dashboardPreflightMs: number;
    dashboardTestMs: number;
    dashboardCreateMs: number;
  };
}

export interface DashboardCreateError {
  code: DashboardCreateErrorCode;
  retryable: boolean;
  operation?: DashboardOperation;
  dashboardShape?: DashboardShapeDiagnostics;
  submitAttempted?: boolean;
  durations?: Partial<DashboardCreateResult["durations"]>;
}

/**
 * Port for the connector-creation half of provisioning, which Sprites only
 * exposes through the dashboard. Implemented by PlaywrightDashboardClient and
 * stubbed in tests, so the minting service never touches a browser directly.
 */
export interface DashboardConnectorClient {
  createConnector(
    request: MintConnectorRequest,
  ): Promise<Result<DashboardCreateResult, DashboardCreateError>>;
}
