import type { DashboardCreateError, Result } from "./types";
import { failure, success } from "./types";

export interface DashboardShapeSnapshot {
  currentUrl: string;
  hasSignInForm: boolean;
  hasLiveViewRoot: boolean;
  authMethodValue: string | null;
  formChangeEvent: string | null;
  formSubmitEvent: string | null;
  fieldNames: string[];
  testEvent: string | null;
}

const REQUIRED_FIELD_NAMES = [
  "access_token",
  "auth_header_prefix",
  "auth_method",
  "base_api_url",
  "description",
  "name",
  "refresh_token",
  "test_url",
] as const;

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
  const hasExpectedEvents = snapshot.formChangeEvent === "validate_custom_api_form"
    && snapshot.formSubmitEvent === "create_custom_api"
    && snapshot.testEvent === "test_custom_api"
    && snapshot.authMethodValue === "header";

  if (!snapshot.hasLiveViewRoot || !hasRequiredFields || !hasExpectedEvents) {
    return failure({
      code: "dashboard_drift",
      retryable: false,
    });
  }

  return success(undefined);
}

function isAuthenticationUrl(currentUrl: string): boolean {
  try {
    const url = new URL(currentUrl);
    return url.hostname === "fly.io" && url.pathname.includes("sign-in")
      || url.pathname.includes("/login");
  } catch {
    return true;
  }
}
