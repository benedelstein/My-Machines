import { createRoute, z } from "@hono/zod-openapi";
import { isInternalHostname } from "./internal-hostname";

/**
 * Wire contract for the connector-provisioner internal service: every request
 * and response schema, plus the OpenAPI route definitions that use them. When
 * another service needs to call these routes, extract this contract into its
 * own package (the @repo/api-contract pattern) rather than importing this
 * service; until then it stays provisioner-internal.
 */

const httpsUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
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

const safeHeaderValue = z.string().max(128).refine((value) => !/[\r\n]/u.test(value), {
  message: "Header values cannot contain newlines",
});

// The label value IS the capability: the gateway grants the connector to any
// Sprite carrying a matching label, so every label must declare its class
// (session:/env:) and a non-trivial identifier. Callers must derive the id
// from high-entropy material, not a guessable or reusable public id.
const spriteLabel = z.string().max(63).regex(
  /^(session|env):[A-Za-z0-9][A-Za-z0-9_-]{7,}$/u,
  "Labels must be session:<id> or env:<id> with an id of at least 8 characters",
);

const MintConnectorRequestBaseSchema = z.object({
  // Leaves room for the provisioner's "-<8 char>" uniqueness suffix.
  name: z.string().min(1).max(100).refine((value) => !/[\r\n]/u.test(value)),
  baseApiUrl: httpsUrl,
  token: z.string().min(1).max(16_384),
  testUrl: httpsUrl,
  headerName: z.literal("Authorization").default("Authorization"),
  headerPrefix: safeHeaderValue.default("Bearer"),
  spriteLabels: z.array(spriteLabel).min(1).max(16),
  // Paths on the connector base the gateway should allow. Optional until the
  // api-server integration always pins session-connector paths.
  allowedEndpoints: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
});

function requireMatchingTestOrigin(
  value: z.infer<typeof MintConnectorRequestBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (new URL(value.baseApiUrl).origin !== new URL(value.testUrl).origin) {
    context.addIssue({
      code: "custom",
      path: ["testUrl"],
      message: "Test URL must use the base API origin",
    });
  }
}

export const MintConnectorRequestSchema = MintConnectorRequestBaseSchema.superRefine(
  requireMatchingTestOrigin,
);

export type MintConnectorRequest = z.infer<typeof MintConnectorRequestSchema>;

export const LiveTestRequestSchema = MintConnectorRequestBaseSchema.superRefine(
  requireMatchingTestOrigin,
);

export type LiveTestRequest = z.infer<typeof LiveTestRequestSchema>;

/** Observed dashboard form shape, attached to `dashboard_drift` failures. */
export const DashboardShapeDiagnosticsSchema = z.object({
  hasLiveViewRoot: z.boolean(),
  authMethodOptions: z.array(z.string()),
  formChangeEvent: z.string().nullable(),
  formSubmitEvent: z.string().nullable(),
  fieldNames: z.array(z.string()),
  testEvent: z.string().nullable(),
});

export type DashboardShapeDiagnostics = z.infer<typeof DashboardShapeDiagnosticsSchema>;

export const CleanupStatusSchema = z.object({
  attempted: z.boolean(),
  succeeded: z.boolean(),
});

export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;

export const ConnectorProvisioningDurationsSchema = z.object({
  browserLaunchMs: z.number().optional(),
  dashboardPreflightMs: z.number().optional(),
  dashboardTestMs: z.number().optional(),
  dashboardCreateMs: z.number().optional(),
  listAfterMs: z.number().optional(),
  scopeMs: z.number().optional(),
  verifyMs: z.number().optional(),
  cleanupMs: z.number().optional(),
  totalMs: z.number(),
});

export type ConnectorProvisioningDurations = z.infer<typeof ConnectorProvisioningDurationsSchema>;

// Error envelope for every provisioner error response. Only `code` is
// guaranteed; provisioning failures carry the full ConnectorProvisionerError
// while boundary rejections (unauthorized, not_found, ...) send just a code.
export const ConnectorProvisionerErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    stage: z.string().optional(),
    retryable: z.boolean().optional(),
    dashboardOperation: z.string().optional(),
    dashboardShape: DashboardShapeDiagnosticsSchema.optional(),
    message: z.string().optional(),
    cleanup: CleanupStatusSchema.optional(),
    durations: ConnectorProvisioningDurationsSchema.optional(),
  }),
});

export type ConnectorProvisionerErrorResponse = z.infer<
  typeof ConnectorProvisionerErrorResponseSchema
>;

export const ConnectorAccessPolicySchema = z.object({
  allowAll: z.boolean(),
  spriteLabels: z.array(z.string()),
  namePrefix: z.string().optional(),
  allowedEndpoints: z.array(z.string()).optional(),
  blockedEndpoints: z.array(z.string()).optional(),
});

const MintedConnectorSchema = z.object({
  name: z.string(),
  gatewayConnectionId: z.string(),
  detailId: z.string().optional(),
});

export const MintConnectorResponseSchema = z.object({
  connector: MintedConnectorSchema,
  policy: ConnectorAccessPolicySchema,
  durations: ConnectorProvisioningDurationsSchema,
});

export type MintConnectorResponse = z.infer<typeof MintConnectorResponseSchema>;

export const LiveTestConnectorResponseSchema = z.object({
  connector: MintedConnectorSchema.extend({ deleted: z.literal(true) }),
  policy: ConnectorAccessPolicySchema,
  durations: ConnectorProvisioningDurationsSchema,
});

export type LiveTestConnectorResponse = z.infer<typeof LiveTestConnectorResponseSchema>;

export const DeleteConnectorResponseSchema = z.object({
  connector: z.object({
    gatewayConnectionId: z.string(),
    deleted: z.literal(true),
  }),
});

export type DeleteConnectorResponse = z.infer<typeof DeleteConnectorResponseSchema>;

const errorContent = {
  content: { "application/json": { schema: ConnectorProvisionerErrorResponseSchema } },
};

export const mintConnectorRoute = createRoute({
  method: "post",
  path: "/mint",
  request: {
    body: {
      content: { "application/json": { schema: MintConnectorRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: MintConnectorResponseSchema } },
      description: "Connector minted and scoped to the requested sprite labels",
    },
    400: { ...errorContent, description: "Invalid request body" },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    502: { ...errorContent, description: "Provisioning failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});

export const liveTestConnectorRoute = createRoute({
  method: "post",
  path: "/live-test",
  request: {
    body: {
      content: { "application/json": { schema: LiveTestRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: LiveTestConnectorResponseSchema } },
      description: "Disposable connector minted, verified, and deleted",
    },
    400: { ...errorContent, description: "Invalid request body" },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    502: { ...errorContent, description: "Provisioning or cleanup failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});

export const deleteConnectorRoute = createRoute({
  method: "delete",
  path: "/{gatewayConnectionId}",
  request: {
    params: z.object({ gatewayConnectionId: z.string().min(1) }),
    // Deleting an environment connector revokes a long-lived user credential,
    // so it must be requested explicitly instead of hiding behind the default.
    query: z.object({
      scope: z.enum(["session", "environment"]).default("session"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: DeleteConnectorResponseSchema } },
      description: "Connector deleted",
    },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    403: { ...errorContent, description: "Connector is not a deletable session connector" },
    404: { ...errorContent, description: "Connector not found" },
    502: { ...errorContent, description: "Delete failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});
