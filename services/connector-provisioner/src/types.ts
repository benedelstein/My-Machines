import { z } from "zod";
import type { Result } from "@repo/shared";
import type { AccessPolicy, SpritesRestErrorCode } from "@repo/sprites-client";

/**
 * Wire contract for the connector-provisioner internal service. The
 * provisioner validates requests and types responses against these schemas.
 * When another service needs to call these routes, extract this contract into
 * its own package (the @repo/api-contract pattern) rather than importing this
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

// Blocks literal internal addresses only; the dashboard's "Test connection"
// executes from Fly's backend, so DNS names resolving to private ranges
// cannot be checked here.
function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (normalized.startsWith("[")) {
    const ipv6 = normalized.slice(1, -1);
    return ipv6 === "::1"
      || ipv6 === "::"
      || /^f[cd]/u.test(ipv6)
      || ipv6.startsWith("fe80:")
      || ipv6.startsWith("::ffff:");
  }
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first = 0, second = 0] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  return false;
}

const safeHeaderValue = z.string().max(128).refine((value) => !/[\r\n]/u.test(value), {
  message: "Header values cannot contain newlines",
});

const MintConnectorRequestBaseSchema = z.object({
  // Leaves room for the provisioner's "-<8 char>" uniqueness suffix.
  name: z.string().min(1).max(100).refine((value) => !/[\r\n]/u.test(value)),
  baseApiUrl: httpsUrl,
  token: z.string().min(1).max(16_384),
  testUrl: httpsUrl,
  headerName: z.literal("Authorization").default("Authorization"),
  headerPrefix: safeHeaderValue.default("Bearer"),
  spriteLabels: z.array(z.string().min(1).max(63)).min(1).max(16),
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

export type DashboardCreateErrorCode =
  | "reauthentication_required"
  | "dashboard_drift"
  | "connection_test_failed"
  | "dashboard_browser_failed"
  | "dashboard_navigation_failed"
  | "dashboard_create_failed";

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

export const DashboardShapeDiagnosticsSchema = z.object({
  hasLiveViewRoot: z.boolean(),
  authMethodOptions: z.array(z.string()),
  formChangeEvent: z.string().nullable(),
  formSubmitEvent: z.string().nullable(),
  fieldNames: z.array(z.string()),
  testEvent: z.string().nullable(),
});

export type DashboardShapeDiagnostics = z.infer<typeof DashboardShapeDiagnosticsSchema>;

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

export interface DashboardConnectorClient {
  createConnector(
    request: MintConnectorRequest,
  ): Promise<Result<DashboardCreateResult, DashboardCreateError>>;
}

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

export interface MintConnectorResult {
  name: string;
  gatewayConnectionId: string;
  detailId?: string;
  accessPolicy: AccessPolicy;
  durations: ConnectorProvisioningDurations;
}

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
