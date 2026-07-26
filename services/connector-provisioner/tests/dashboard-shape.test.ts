import { describe, expect, it } from "vitest";
import {
  validateDashboardShape,
  type DashboardShapeSnapshot,
} from "../src/dashboard-shape";

const expectedFields = [
  "access_token",
  "auth_header_prefix",
  "base_api_url",
  "description",
  "name",
  "refresh_token",
  "test_url",
];

function validShape(): DashboardShapeSnapshot {
  return {
    currentUrl: "https://fly.io/dashboard/example/sprites/connectors/new?type=custom_api",
    hasSignInForm: false,
    hasLiveViewRoot: true,
    authMethodOptions: ["Header", "URL path", "Query param", "Custom header"],
    formChangeEvent: "validate_custom_api",
    formSubmitEvent: "submit_custom_api",
    fieldNames: expectedFields,
    testEvent: "test_custom_api",
  };
}

describe("validateDashboardShape", () => {
  it("accepts the expected LiveView form before a secret is entered", () => {
    expect(validateDashboardShape(validShape())).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("classifies an expired dashboard session", () => {
    const shape = {
      ...validShape(),
      currentUrl: "https://fly.io/app/sign-in",
      hasSignInForm: true,
    };

    expect(validateDashboardShape(shape)).toEqual({
      ok: false,
      error: {
        code: "reauthentication_required",
        retryable: false,
      },
    });
  });

  it("fails closed when a required selector drifts", () => {
    const shape = {
      ...validShape(),
      fieldNames: expectedFields.filter((fieldName) => fieldName !== "access_token"),
    };

    expect(validateDashboardShape(shape)).toMatchObject({
      ok: false,
      error: {
        code: "dashboard_drift",
        retryable: false,
        dashboardShape: {
          fieldNames: expectedFields.filter((fieldName) => fieldName !== "access_token"),
        },
      },
    });
  });
});
