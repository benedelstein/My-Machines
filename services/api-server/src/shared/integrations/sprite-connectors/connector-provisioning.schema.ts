import { z } from "zod";
import {
  AccessPolicySchema,
  CreateCustomApiConnectorRequestSchema,
} from "@repo/sprites-client";
import { isInternalHostname } from "./internal-hostname";

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const httpsUrl = z.string().superRefine((value, context) => {
  const url = parseUrl(value);
  if (url === undefined) {
    context.addIssue({
      code: "custom",
      message: "A valid URL is required",
    });
    return;
  }
  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "HTTPS is required",
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    context.addIssue({
      code: "custom",
      message: "URL userinfo is not allowed",
    });
  }
  if (isInternalHostname(url.hostname)) {
    context.addIssue({
      code: "custom",
      message: "Internal hostnames are not allowed",
    });
  }
});

const spriteLabel = z.string().max(63).regex(
  /^(session|env):[A-Za-z0-9][A-Za-z0-9_-]{7,}$/u,
  "Labels must be session:<id> or env:<id> with an id of at least 8 characters",
);

const endpoint = z.string().min(1).max(256);

const ConnectorProvisioningRequestBaseSchema = CreateCustomApiConnectorRequestSchema.extend({
  baseApiUrl: httpsUrl,
  testUrl: httpsUrl,
  description: z.string().max(1_024).default("Provisioned by My Machines"),
  accessPolicy: AccessPolicySchema.extend({
    allowAll: z.literal(false),
    spriteLabels: z.array(spriteLabel).min(1).max(16),
    namePrefix: z.never().optional(),
    allowedEndpoints: z.array(endpoint).min(1).max(32).optional(),
    blockedEndpoints: z.array(endpoint).max(32).optional(),
  }).strict(),
});

function requireMatchingTestOrigin(
  value: z.infer<typeof ConnectorProvisioningRequestBaseSchema>,
  context: z.RefinementCtx,
): void {
  const baseUrl = parseUrl(value.baseApiUrl);
  const testUrl = parseUrl(value.testUrl);
  if (baseUrl !== undefined && testUrl !== undefined && baseUrl.origin !== testUrl.origin) {
    context.addIssue({
      code: "custom",
      path: ["testUrl"],
      message: "Test URL must use the base API origin",
    });
  }
}

function requireSessionEndpointPins(
  value: z.infer<typeof ConnectorProvisioningRequestBaseSchema>,
  context: z.RefinementCtx,
): void {
  // A connector carrying any session label is reachable by that session's
  // Sprite, even when the policy also contains environment labels.
  const hasSessionLabel = value.accessPolicy.spriteLabels.some((label) =>
    label.startsWith("session:"));
  if (hasSessionLabel && value.accessPolicy.allowedEndpoints === undefined) {
    context.addIssue({
      code: "custom",
      path: ["accessPolicy", "allowedEndpoints"],
      message: "Session connectors must pin allowedEndpoints",
    });
  }
}

export const ConnectorProvisioningRequestSchema = ConnectorProvisioningRequestBaseSchema
  .superRefine(requireMatchingTestOrigin)
  .superRefine(requireSessionEndpointPins);
