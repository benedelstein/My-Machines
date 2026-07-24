import { z } from "zod";

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
  name: z.string().min(1).max(120).refine((value) => !/[\r\n]/u.test(value)),
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

export interface AccessPolicy {
  allowAll: boolean;
  spriteLabels: string[];
  namePrefix?: string;
  allowedEndpoints?: string[];
  blockedEndpoints?: string[];
}

export interface SpritesConnection {
  id: string;
  provider: string;
  providerAccountName?: string;
  providerInfo?: Record<string, unknown>;
  accessPolicy?: AccessPolicy;
}

export interface DashboardCreateResult {
  detailId?: string;
  durations: {
    browserLaunchMs: number;
    dashboardPreflightMs: number;
    dashboardTestMs: number;
    dashboardCreateMs: number;
  };
}

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

export interface DashboardShapeDiagnostics {
  hasLiveViewRoot: boolean;
  authMethodOptions: string[];
  formChangeEvent: string | null;
  formSubmitEvent: string | null;
  fieldNames: string[];
  testEvent: string | null;
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

export type SpritesRestErrorCode =
  | "sprites_authentication_failed"
  | "sprites_rate_limited"
  | "sprites_request_failed"
  | "sprites_response_invalid";

export interface SpritesRestError {
  code: SpritesRestErrorCode;
  retryable: boolean;
}

export interface SpritesConnectionsClient {
  listConnections(): Promise<Result<SpritesConnection[], SpritesRestError>>;
  updateAccessPolicy(
    connectionId: string,
    policy: AccessPolicy,
  ): Promise<Result<SpritesConnection, SpritesRestError>>;
  getConnection(
    connectionId: string,
  ): Promise<Result<SpritesConnection | null, SpritesRestError>>;
  deleteConnection(connectionId: string): Promise<Result<void, SpritesRestError>>;
}

export type ProvisioningStage =
  | "list_before"
  | "dashboard_create"
  | "list_after"
  | "scope"
  | "verify"
  | "cleanup";

export type ConnectorProvisionerErrorCode =
  | DashboardCreateErrorCode
  | SpritesRestErrorCode
  | "connector_name_conflict"
  | "connector_reconciliation_failed"
  | "orphan_reconciliation_required"
  | "policy_verification_failed"
  | "cleanup_failed";

export interface CleanupStatus {
  attempted: boolean;
  succeeded: boolean;
}

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

export interface ConnectorProvisioningDurations {
  browserLaunchMs?: number;
  dashboardPreflightMs?: number;
  dashboardTestMs?: number;
  dashboardCreateMs?: number;
  listBeforeMs?: number;
  listAfterMs?: number;
  scopeMs?: number;
  verifyMs?: number;
  cleanupMs?: number;
  totalMs: number;
}

export interface MintConnectorResult {
  gatewayConnectionId: string;
  detailId?: string;
  accessPolicy: AccessPolicy;
  durations: ConnectorProvisioningDurations;
}

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
