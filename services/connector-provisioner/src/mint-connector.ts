import type {
  AccessPolicy,
  CleanupStatus,
  ConnectorProvisionerError,
  ConnectorProvisionerErrorCode,
  ConnectorProvisioningDurations,
  DashboardConnectorClient,
  MintConnectorRequest,
  MintConnectorResult,
  ProvisioningStage,
  Result,
  SpritesConnection,
  SpritesConnectionsClient,
} from "./types";
import { failure, success } from "./types";

interface MintConnectorDependencies {
  dashboard: DashboardConnectorClient;
  sprites: SpritesConnectionsClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function mintConnector(
  request: MintConnectorRequest,
  dependencies: MintConnectorDependencies,
): Promise<Result<MintConnectorResult, ConnectorProvisionerError>> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const sleep = dependencies.sleep ?? delay;
  const startedAt = now();
  const durations: ConnectorProvisioningDurations = { totalMs: 0 };

  const listBeforeStartedAt = now();
  const beforeResult = await dependencies.sprites.listConnections();
  durations.listBeforeMs = now() - listBeforeStartedAt;
  if (!beforeResult.ok) {
    return failure(buildError({
      code: beforeResult.error.code,
      stage: "list_before",
      retryable: beforeResult.error.retryable,
      cleanup: notAttempted(),
      durations,
      startedAt,
      now,
    }));
  }
  if (beforeResult.value.some((connection) => {
    return connection.provider === "custom_api"
      && connection.providerAccountName === request.name;
  })) {
    return failure(buildError({
      code: "connector_name_conflict",
      stage: "list_before",
      retryable: false,
      cleanup: notAttempted(),
      durations,
      startedAt,
      now,
    }));
  }

  const dashboardStartedAt = now();
  const dashboardResult = await dependencies.dashboard.createConnector(request);
  const dashboardDurationMs = now() - dashboardStartedAt;
  if (!dashboardResult.ok) {
    Object.assign(durations, dashboardResult.error.durations);
    durations.dashboardCreateMs ??= dashboardDurationMs;
    if (dashboardResult.error.submitAttempted === true) {
      return failure(await reconcileAfterUncertainSubmit({
        originalCode: dashboardResult.error.code,
        before: beforeResult.value,
        request,
        dependencies,
        sleep,
        durations,
        startedAt,
        now,
      }));
    }
    return failure(buildError({
      code: dashboardResult.error.code,
      stage: "dashboard_create",
      retryable: dashboardResult.error.retryable,
      cleanup: notAttempted(),
      durations,
      startedAt,
      now,
    }));
  }
  Object.assign(durations, dashboardResult.value.durations);

  const listAfterStartedAt = now();
  const afterResult = await listConnectionsAfterCreate(
    dependencies.sprites,
    sleep,
    beforeResult.value,
    request,
  );
  durations.listAfterMs = now() - listAfterStartedAt;
  if (!afterResult.ok) {
    return failure(buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      cleanup: notAttempted(),
      durations,
      startedAt,
      now,
    }));
  }

  const reconciliation = reconcileCreatedConnection(
    beforeResult.value,
    afterResult.value,
    request,
  );
  if (reconciliation.connection === undefined) {
    const cleanup = await cleanupConnections(
      reconciliation.attributableConnectionIds,
      dependencies.sprites,
      now,
      durations,
    );
    return failure(buildError({
      code: reconciliation.attributableConnectionIds.length === 0
        ? "orphan_reconciliation_required"
        : "connector_reconciliation_failed",
      stage: "list_after",
      retryable: reconciliation.attributableConnectionIds.length === 0,
      cleanup,
      durations,
      startedAt,
      now,
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
  durations.scopeMs = now() - scopeStartedAt;
  if (!scopeResult.ok) {
    return failure(await buildErrorWithCleanup({
      code: scopeResult.error.code,
      stage: "scope",
      retryable: scopeResult.error.retryable,
      gatewayConnectionId,
      dependencies,
      durations,
      startedAt,
      now,
    }));
  }

  const verifyStartedAt = now();
  const verifyResult = await dependencies.sprites.getConnection(gatewayConnectionId);
  durations.verifyMs = now() - verifyStartedAt;
  if (!verifyResult.ok) {
    return failure(await buildErrorWithCleanup({
      code: verifyResult.error.code,
      stage: "verify",
      retryable: verifyResult.error.retryable,
      gatewayConnectionId,
      dependencies,
      durations,
      startedAt,
      now,
    }));
  }

  if (verifyResult.value === null || !policiesMatch(verifyResult.value.accessPolicy, accessPolicy)) {
    return failure(await buildErrorWithCleanup({
      code: "policy_verification_failed",
      stage: "verify",
      retryable: false,
      gatewayConnectionId,
      dependencies,
      durations,
      startedAt,
      now,
    }));
  }

  durations.totalMs = now() - startedAt;
  return success({
    gatewayConnectionId,
    ...(dashboardResult.value.detailId === undefined
      ? {}
      : { detailId: dashboardResult.value.detailId }),
    accessPolicy,
    durations,
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
  before: SpritesConnection[],
  after: SpritesConnection[],
  request: MintConnectorRequest,
): {
  connection?: SpritesConnection;
  attributableConnectionIds: string[];
} {
  const attributableConnections = findAttributableConnections(before, after, request);
  const matches = attributableConnections.filter((connection) => {
    return connection.providerAccountName === request.name
      && providerInfoUrlMatches(connection.providerInfo, "base_api_url", request.baseApiUrl)
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function buildErrorWithCleanup(params: {
  code: ConnectorProvisionerErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  gatewayConnectionId: string;
  dependencies: MintConnectorDependencies;
  durations: ConnectorProvisioningDurations;
  startedAt: number;
  now: () => number;
}): Promise<ConnectorProvisionerError> {
  const cleanup = await cleanupConnections(
    [params.gatewayConnectionId],
    params.dependencies.sprites,
    params.now,
    params.durations,
  );

  return buildError({
    code: params.code,
    stage: params.stage,
    retryable: params.retryable,
    cleanup,
    durations: params.durations,
    startedAt: params.startedAt,
    now: params.now,
  });
}

function buildError(params: {
  code: ConnectorProvisionerErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  cleanup: CleanupStatus;
  durations: ConnectorProvisioningDurations;
  startedAt: number;
  now: () => number;
}): ConnectorProvisionerError {
  params.durations.totalMs = params.now() - params.startedAt;
  return {
    code: params.code,
    stage: params.stage,
    retryable: params.retryable,
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
    case "connector_name_conflict":
      return "A connector already uses this provisioning name.";
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

function notAttempted(): CleanupStatus {
  return {
    attempted: false,
    succeeded: false,
  };
}

async function listConnectionsAfterCreate(
  sprites: SpritesConnectionsClient,
  sleep: (milliseconds: number) => Promise<void>,
  before: SpritesConnection[],
  request: MintConnectorRequest,
): Promise<Awaited<ReturnType<SpritesConnectionsClient["listConnections"]>>> {
  const retryDelays = [0, 250, 750, 1_500];
  let lastResult: Awaited<ReturnType<SpritesConnectionsClient["listConnections"]>> | undefined;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) {
      await sleep(retryDelay);
    }
    lastResult = await sprites.listConnections();
    if (lastResult.ok && findAttributableConnections(
      before,
      lastResult.value,
      request,
    ).length > 0) {
      return lastResult;
    }
  }

  return lastResult ?? failure({
    code: "sprites_request_failed",
    retryable: true,
  });
}

async function cleanupConnections(
  connectionIds: string[],
  sprites: SpritesConnectionsClient,
  now: () => number,
  durations: ConnectorProvisioningDurations,
): Promise<CleanupStatus> {
  if (connectionIds.length === 0) {
    return notAttempted();
  }

  const cleanupStartedAt = now();
  const results = await Promise.all(
    connectionIds.map((connectionId) => deleteConnectorAndVerify(connectionId, sprites)),
  );
  durations.cleanupMs = now() - cleanupStartedAt;
  return {
    attempted: true,
    succeeded: results.every((result) => result.ok),
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reconcileAfterUncertainSubmit(params: {
  originalCode: ConnectorProvisionerErrorCode;
  before: SpritesConnection[];
  request: MintConnectorRequest;
  dependencies: MintConnectorDependencies;
  sleep: (milliseconds: number) => Promise<void>;
  durations: ConnectorProvisioningDurations;
  startedAt: number;
  now: () => number;
}): Promise<ConnectorProvisionerError> {
  const listAfterStartedAt = params.now();
  const afterResult = await listConnectionsAfterCreate(
    params.dependencies.sprites,
    params.sleep,
    params.before,
    params.request,
  );
  params.durations.listAfterMs = params.now() - listAfterStartedAt;
  if (!afterResult.ok) {
    return buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      cleanup: notAttempted(),
      durations: params.durations,
      startedAt: params.startedAt,
      now: params.now,
    });
  }

  const attributableIds = findAttributableConnections(
    params.before,
    afterResult.value,
    params.request,
  ).map((connection) => connection.id);
  const cleanup = await cleanupConnections(
    attributableIds,
    params.dependencies.sprites,
    params.now,
    params.durations,
  );
  return buildError({
    code: attributableIds.length === 0
      ? "orphan_reconciliation_required"
      : params.originalCode,
    stage: attributableIds.length === 0 ? "list_after" : "dashboard_create",
    retryable: attributableIds.length === 0,
    cleanup,
    durations: params.durations,
    startedAt: params.startedAt,
    now: params.now,
  });
}

function findAttributableConnections(
  before: SpritesConnection[],
  after: SpritesConnection[],
  request: MintConnectorRequest,
): SpritesConnection[] {
  const existingIds = new Set(before.map((connection) => connection.id));
  return after.filter((connection) => {
    return !existingIds.has(connection.id)
      && connection.provider === "custom_api"
      && connection.providerAccountName === request.name;
  });
}
