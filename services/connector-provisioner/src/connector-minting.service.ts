import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  SpritesConnection,
  SpritesConnectionsClient,
} from "@repo/sprites-client";
import type {
  CleanupStatus,
  ConnectorProvisionerError,
  ConnectorProvisionerErrorCode,
  ConnectorProvisioningDurations,
  DashboardConnectorClient,
  MintConnectorRequest,
  MintConnectorResult,
  ProvisioningStage,
} from "./types";
import { arraysEqual } from "./utils";

interface MintConnectorDependencies {
  dashboard: DashboardConnectorClient;
  sprites: SpritesConnectionsClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nameSuffix?: () => string;
}

const NOT_ATTEMPTED: CleanupStatus = Object.freeze({
  attempted: false,
  succeeded: false,
});

/** Stage timings collected so far; totalMs is added at each exit point. */
type PartialDurations = Omit<ConnectorProvisioningDurations, "totalMs">;

export async function mintConnector(
  callerRequest: MintConnectorRequest,
  dependencies: MintConnectorDependencies,
): Promise<Result<MintConnectorResult, ConnectorProvisionerError>> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const sleep = dependencies.sleep ?? delay;
  const nameSuffix = dependencies.nameSuffix ?? defaultNameSuffix;
  // The suffixed name is globally unique per attempt, so name-based
  // attribution and delete-on-failure can only ever match this call's own
  // connector, even across concurrent duplicate requests.
  const request: MintConnectorRequest = {
    ...callerRequest,
    name: `${callerRequest.name}-${nameSuffix()}`,
  };
  const startedAt = now();

  const dashboardStartedAt = now();
  const dashboardResult = await dependencies.dashboard.createConnector(request);
  const dashboardMs = now() - dashboardStartedAt;
  if (!dashboardResult.ok) {
    // Prefer the dashboard client's own stage timings; fall back to the
    // whole-call stopwatch when it failed before reporting the create step.
    const dashboardDurations: PartialDurations = {
      ...dashboardResult.error.durations,
      dashboardCreateMs: dashboardResult.error.durations?.dashboardCreateMs ?? dashboardMs,
    };
    if (dashboardResult.error.submitAttempted === true) {
      return failure(await reconcileAfterUncertainSubmit({
        originalCode: dashboardResult.error.code,
        dashboardOperation: dashboardResult.error.operation,
        dashboardShape: dashboardResult.error.dashboardShape,
        request,
        dependencies,
        sleep,
        dashboardDurations,
        startedAt,
        now,
      }));
    }
    return failure(buildError({
      code: dashboardResult.error.code,
      stage: "dashboard_create",
      retryable: dashboardResult.error.retryable,
      dashboardOperation: dashboardResult.error.operation,
      dashboardShape: dashboardResult.error.dashboardShape,
      cleanup: NOT_ATTEMPTED,
      durations: { ...dashboardDurations, totalMs: now() - startedAt },
    }));
  }
  const dashboardDurations: PartialDurations = dashboardResult.value.durations;

  const listAfterStartedAt = now();
  const afterResult = await listConnectionsAfterCreate(
    dependencies.sprites,
    sleep,
    request,
  );
  const listAfterMs = now() - listAfterStartedAt;
  if (!afterResult.ok) {
    return failure(buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      cleanup: NOT_ATTEMPTED,
      durations: { ...dashboardDurations, listAfterMs, totalMs: now() - startedAt },
    }));
  }

  const reconciliation = reconcileCreatedConnection(afterResult.value, request);
  if (reconciliation.connection === undefined) {
    // An ambiguous match set can include a concurrent mint's live connector;
    // deleting on ambiguity is worse than leaking a deny-all orphan.
    return failure(buildError({
      code: reconciliation.attributableConnectionIds.length === 0
        ? "orphan_reconciliation_required"
        : "connector_reconciliation_failed",
      stage: "list_after",
      retryable: reconciliation.attributableConnectionIds.length === 0,
      cleanup: NOT_ATTEMPTED,
      durations: { ...dashboardDurations, listAfterMs, totalMs: now() - startedAt },
    }));
  }
  const gatewayConnectionId = reconciliation.connection.id;

  const accessPolicy: AccessPolicy = {
    allowAll: false,
    spriteLabels: [...request.spriteLabels],
  };

  const scopeStartedAt = now();
  const scopeResult = await dependencies.sprites.updateAccessPolicy(
    gatewayConnectionId,
    accessPolicy,
  );
  const scopeMs = now() - scopeStartedAt;
  if (!scopeResult.ok) {
    const cleanup = await cleanupConnector(gatewayConnectionId, dependencies.sprites, now);
    return failure(buildError({
      code: scopeResult.error.code,
      stage: "scope",
      retryable: scopeResult.error.retryable,
      cleanup: cleanup.status,
      durations: {
        ...dashboardDurations,
        listAfterMs,
        scopeMs,
        cleanupMs: cleanup.cleanupMs,
        totalMs: now() - startedAt,
      },
    }));
  }

  const verifyStartedAt = now();
  const verifyResult = await dependencies.sprites.getConnection(gatewayConnectionId);
  const verifyMs = now() - verifyStartedAt;
  if (!verifyResult.ok) {
    const cleanup = await cleanupConnector(gatewayConnectionId, dependencies.sprites, now);
    return failure(buildError({
      code: verifyResult.error.code,
      stage: "verify",
      retryable: verifyResult.error.retryable,
      cleanup: cleanup.status,
      durations: {
        ...dashboardDurations,
        listAfterMs,
        scopeMs,
        verifyMs,
        cleanupMs: cleanup.cleanupMs,
        totalMs: now() - startedAt,
      },
    }));
  }

  if (verifyResult.value === null || !policiesMatch(verifyResult.value.accessPolicy, accessPolicy)) {
    const cleanup = await cleanupConnector(gatewayConnectionId, dependencies.sprites, now);
    return failure(buildError({
      code: "policy_verification_failed",
      stage: "verify",
      retryable: false,
      cleanup: cleanup.status,
      durations: {
        ...dashboardDurations,
        listAfterMs,
        scopeMs,
        verifyMs,
        cleanupMs: cleanup.cleanupMs,
        totalMs: now() - startedAt,
      },
    }));
  }

  return success({
    name: request.name,
    gatewayConnectionId,
    ...(dashboardResult.value.detailId === undefined
      ? {}
      : { detailId: dashboardResult.value.detailId }),
    accessPolicy,
    durations: {
      ...dashboardDurations,
      listAfterMs,
      scopeMs,
      verifyMs,
      totalMs: now() - startedAt,
    },
  });
}

export async function deleteConnectorAndVerify(
  connectionId: string,
  sprites: SpritesConnectionsClient,
): Promise<Result<void, ConnectorProvisionerErrorCode>> {
  const deleteResult = await sprites.deleteConnection(connectionId);
  if (!deleteResult.ok) {
    return failure("cleanup_failed");
  }

  const getResult = await sprites.getConnection(connectionId);
  if (!getResult.ok || getResult.value !== null) {
    return failure("cleanup_failed");
  }

  return success(undefined);
}

function reconcileCreatedConnection(
  connections: SpritesConnection[],
  request: MintConnectorRequest,
): {
  connection?: SpritesConnection;
  attributableConnectionIds: string[];
} {
  const attributableConnections = findConnectionsByName(connections, request);
  const matches = attributableConnections.filter((connection) => {
    return providerInfoUrlMatches(connection.providerInfo, "base_api_url", request.baseApiUrl)
      && providerInfoUrlMatches(connection.providerInfo, "test_url", request.testUrl);
  });

  return {
    ...(attributableConnections.length === 1 && matches.length === 1
      ? { connection: matches[0] }
      : {}),
    attributableConnectionIds: attributableConnections.map((connection) => connection.id),
  };
}

function providerInfoUrlMatches(
  providerInfo: Record<string, unknown> | undefined,
  field: string,
  expected: string,
): boolean {
  const actual = providerInfo?.[field];
  if (typeof actual !== "string") {
    return false;
  }
  const normalizedActual = normalizeUrl(actual);
  return normalizedActual !== undefined && normalizedActual === normalizeUrl(expected);
}

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function policiesMatch(
  actual: AccessPolicy | undefined,
  expected: AccessPolicy,
): boolean {
  if (actual?.allowAll !== false || actual.namePrefix !== undefined) {
    return false;
  }

  return arraysEqual(
    [...actual.spriteLabels].sort(),
    [...expected.spriteLabels].sort(),
  );
}

function buildError(params: {
  code: ConnectorProvisionerErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  dashboardOperation?: ConnectorProvisionerError["dashboardOperation"];
  dashboardShape?: ConnectorProvisionerError["dashboardShape"];
  cleanup: CleanupStatus;
  durations: ConnectorProvisioningDurations;
}): ConnectorProvisionerError {
  return {
    code: params.code,
    stage: params.stage,
    retryable: params.retryable,
    ...(params.dashboardOperation === undefined
      ? {}
      : { dashboardOperation: params.dashboardOperation }),
    ...(params.dashboardShape === undefined
      ? {}
      : { dashboardShape: params.dashboardShape }),
    message: errorMessage(params.code),
    cleanup: params.cleanup,
    durations: params.durations,
  };
}

function errorMessage(code: ConnectorProvisionerErrorCode): string {
  switch (code) {
    case "reauthentication_required":
      return "Sprites dashboard authentication must be renewed.";
    case "dashboard_drift":
      return "The Sprites dashboard connector form changed.";
    case "connection_test_failed":
      return "The Sprites dashboard rejected the connector test.";
    case "dashboard_create_failed":
      return "The Sprites dashboard did not create the connector.";
    case "dashboard_browser_failed":
      return "The remote browser could not be launched or initialized.";
    case "dashboard_navigation_failed":
      return "The remote browser could not load the Sprites dashboard.";
    case "connector_reconciliation_failed":
      return "The created connector could not be identified safely.";
    case "orphan_reconciliation_required":
      return "The dashboard submit may have created an untracked connector.";
    case "policy_verification_failed":
      return "The connector access policy could not be verified.";
    case "sprites_authentication_failed":
      return "Sprites API authentication failed.";
    case "sprites_rate_limited":
      return "Sprites API rate limited connector provisioning.";
    case "sprites_request_failed":
      return "A Sprites API request failed.";
    case "sprites_response_invalid":
      return "Sprites API returned an unexpected response.";
    case "cleanup_failed":
      return "The disposable connector could not be removed.";
    default: {
      const exhaustiveCheck: never = code;
      throw new Error(`Unhandled connector provisioner error: ${exhaustiveCheck}`);
    }
  }
}

async function listConnectionsAfterCreate(
  sprites: SpritesConnectionsClient,
  sleep: (milliseconds: number) => Promise<void>,
  request: MintConnectorRequest,
): Promise<Awaited<ReturnType<SpritesConnectionsClient["listConnections"]>>> {
  const retryDelays = [0, 250, 750, 1_500];
  let lastResult: Awaited<ReturnType<SpritesConnectionsClient["listConnections"]>> | undefined;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) {
      await sleep(retryDelay);
    }
    lastResult = await sprites.listConnections();
    if (lastResult.ok && findConnectionsByName(lastResult.value, request).length > 0) {
      return lastResult;
    }
  }

  return lastResult ?? failure({
    code: "sprites_request_failed",
    retryable: true,
  });
}

async function cleanupConnector(
  connectionId: string,
  sprites: SpritesConnectionsClient,
  now: () => number,
): Promise<{ status: CleanupStatus; cleanupMs: number }> {
  const cleanupStartedAt = now();
  const result = await deleteConnectorAndVerify(connectionId, sprites);
  return {
    status: { attempted: true, succeeded: result.ok },
    cleanupMs: now() - cleanupStartedAt,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultNameSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function reconcileAfterUncertainSubmit(params: {
  originalCode: ConnectorProvisionerErrorCode;
  dashboardOperation?: ConnectorProvisionerError["dashboardOperation"];
  dashboardShape?: ConnectorProvisionerError["dashboardShape"];
  request: MintConnectorRequest;
  dependencies: MintConnectorDependencies;
  sleep: (milliseconds: number) => Promise<void>;
  dashboardDurations: PartialDurations;
  startedAt: number;
  now: () => number;
}): Promise<ConnectorProvisionerError> {
  const { now, startedAt } = params;
  const listAfterStartedAt = now();
  const afterResult = await listConnectionsAfterCreate(
    params.dependencies.sprites,
    params.sleep,
    params.request,
  );
  const listAfterMs = now() - listAfterStartedAt;
  const durations: PartialDurations = { ...params.dashboardDurations, listAfterMs };
  if (!afterResult.ok) {
    return buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      cleanup: NOT_ATTEMPTED,
      durations: { ...durations, totalMs: now() - startedAt },
    });
  }

  const attributable = findConnectionsByName(afterResult.value, params.request);
  const orphan = attributable.length === 1
    && attributable[0] !== undefined
    && providerInfoUrlMatches(attributable[0].providerInfo, "base_api_url", params.request.baseApiUrl)
    && providerInfoUrlMatches(attributable[0].providerInfo, "test_url", params.request.testUrl)
    ? attributable[0]
    : undefined;
  if (attributable.length > 0 && orphan === undefined) {
    // Multiple or unprovable matches may belong to a concurrent mint; never
    // delete what cannot be uniquely attributed to this call.
    return buildError({
      code: "connector_reconciliation_failed",
      stage: "list_after",
      retryable: false,
      dashboardOperation: params.dashboardOperation,
      dashboardShape: params.dashboardShape,
      cleanup: NOT_ATTEMPTED,
      durations: { ...durations, totalMs: now() - startedAt },
    });
  }
  if (orphan === undefined) {
    return buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      dashboardOperation: params.dashboardOperation,
      dashboardShape: params.dashboardShape,
      cleanup: NOT_ATTEMPTED,
      durations: { ...durations, totalMs: now() - startedAt },
    });
  }
  const cleanup = await cleanupConnector(orphan.id, params.dependencies.sprites, now);
  return buildError({
    code: params.originalCode,
    stage: "dashboard_create",
    retryable: false,
    dashboardOperation: params.dashboardOperation,
    dashboardShape: params.dashboardShape,
    cleanup: cleanup.status,
    durations: { ...durations, cleanupMs: cleanup.cleanupMs, totalMs: now() - startedAt },
  });
}

// The per-attempt name suffix is the sole attribution key: only this call's
// dashboard submit can have created a connector with this exact name, so a
// unique name match is proof of ownership without diffing list snapshots.
function findConnectionsByName(
  connections: SpritesConnection[],
  request: MintConnectorRequest,
): SpritesConnection[] {
  return connections.filter((connection) => {
    return connection.provider === "custom_api"
      && connection.providerAccountName === request.name;
  });
}
