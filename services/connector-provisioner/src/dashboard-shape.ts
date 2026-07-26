import { failure, success, type Result } from "@repo/shared";
import type { DashboardShapeDiagnostics } from "./connectors.schema";
import type { DashboardCreateError } from "./types";

export interface DashboardShapeSnapshot extends DashboardShapeDiagnostics {
  currentUrl: string;
  hasSignInForm: boolean;
}

const REQUIRED_FIELD_NAMES = [
  "access_token",
  "auth_header_prefix",
  "base_api_url",
  "description",
  "name",
  "refresh_token",
  "test_url",
] as const;

/**
 * Preflight gate that runs before any secret is typed into the dashboard.
 * Verifies the connector form in `snapshot` still looks the way automation
 * expects: signed-in (else `reauthentication_required`), and with the exact
 * LiveView fields, events, and auth-method options the fill/submit code
 * targets (else `dashboard_drift` with the observed shape attached).
 * Returns a success Result when the form is safe to fill.
 */
export function validateDashboardShape(
  snapshot: DashboardShapeSnapshot,
): Result<void, DashboardCreateError> {
  if (snapshot.hasSignInForm || isAuthenticationUrl(snapshot.currentUrl)) {
    return failure({
      code: "reauthentication_required",
      retryable: false,
    });
  }

  const fieldNames = new Set(snapshot.fieldNames);
  const hasRequiredFields = REQUIRED_FIELD_NAMES.every((fieldName) => fieldNames.has(fieldName));
  const hasExpectedEvents = snapshot.formChangeEvent === "validate_custom_api"
    && snapshot.formSubmitEvent === "submit_custom_api"
    && snapshot.testEvent === "test_custom_api"
    && snapshot.authMethodOptions.includes("Header");

  if (!snapshot.hasLiveViewRoot || !hasRequiredFields || !hasExpectedEvents) {
    return failure({
      code: "dashboard_drift",
      retryable: false,
      dashboardShape: {
        hasLiveViewRoot: snapshot.hasLiveViewRoot,
        authMethodOptions: snapshot.authMethodOptions,
        formChangeEvent: snapshot.formChangeEvent,
        formSubmitEvent: snapshot.formSubmitEvent,
        fieldNames: snapshot.fieldNames,
        testEvent: snapshot.testEvent,
      },
    });
  }

  return success(undefined);
}

export function isAuthenticationUrl(currentUrl: string): boolean {
  try {
    const url = new URL(currentUrl);
    return url.hostname === "fly.io" && url.pathname.includes("sign-in")
      || url.pathname.includes("/login");
  } catch {
    return true;
  }
}
