import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  SpritesConnection,
  SpriteConnectorsClient,
} from "@repo/sprites-client";
import type {
  CleanupStatus,
  ConnectorProvisioningDurations,
  MintConnectorRequest,
} from "./connectors.schema";
import type {
  ConnectorCleanupError,
  ConnectorProvisionerError,
  ConnectorProvisionerErrorCode,
  DashboardConnectorClient,
  MintConnectorResult,
  ProvisioningStage,
} from "./types";
import { arraysEqual, delay } from "./utils";

interface MintConnectorDependencies {
  dashboardClient: DashboardConnectorClient;
  spritesClient: SpriteConnectorsClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nameSuffix?: () => string;
}

const NOT_ATTEMPTED: CleanupStatus = Object.freeze({
  attempted: false,
  succeeded: false,
});

/** Per-stage timings; `totalMs` is stamped when a snapshot is taken. */
type StageDurations = Omit<ConnectorProvisioningDurations, "totalMs">;

/**
 * One stopwatch per mint attempt. `time` records a stage as it finishes and
 * `snapshot` reports the stages that actually ran plus the elapsed total, so
 * every exit point stays consistent without restating the timing fields.
 */
class MintTimings {
  private readonly stages: StageDurations = {};
  private readonly startedAt: number;

  constructor(private readonly now: () => number) {
    this.startedAt = now();
  }

  async time<T>(stage: keyof StageDurations, operation: () => Promise<T>): Promise<T> {
    const stageStartedAt = this.now();
    try {
      return await operation();
    } finally {
      this.stages[stage] = this.now() - stageStartedAt;
    }
  }

  /** Adopts stage timings measured elsewhere, e.g. inside the dashboard client. */
  record(stages: StageDurations | undefined): void {
    Object.assign(this.stages, stages);
  }

  snapshot(): ConnectorProvisioningDurations {
    return { ...this.stages, totalMs: this.now() - this.startedAt };
  }
}

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
  const timings = new MintTimings(now);

  const dashboardResult = await dependencies.dashboardClient.createConnector(request);
  // The dashboard client measures its own browser stages; a failure reports
  // whichever of them it reached.
  timings.record(dashboardResult.ok
    ? dashboardResult.value.durations
    : dashboardResult.error.durations);
  if (!dashboardResult.ok) {
    if (dashboardResult.error.submitAttempted === true) {
      return failure(await reconcileAfterUncertainSubmit({
        originalCode: dashboardResult.error.code,
        dashboardOperation: dashboardResult.error.operation,
        dashboardShape: dashboardResult.error.dashboardShape,
        request,
        dependencies,
        sleep,
        timings,
      }));
    }
    return failure(buildError({
      code: dashboardResult.error.code,
      stage: "dashboard_create",
      retryable: dashboardResult.error.retryable,
      dashboardOperation: dashboardResult.error.operation,
      dashboardShape: dashboardResult.error.dashboardShape,
      cleanup: NOT_ATTEMPTED,
      timings,
    }));
  }

  const createdConnector = await findCreatedConnector(dependencies.spritesClient, {
    name: request.name,
    sleep,
    timings,
  });
  if (createdConnector === undefined) {
    return failure(buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      cleanup: NOT_ATTEMPTED,
      timings,
    }));
  }
  const gatewayConnectionId = createdConnector.id;

  const accessPolicy: AccessPolicy = {
    allowAll: false,
    spriteLabels: [...request.spriteLabels],
  };

  const scopeResult = await timings.time("scopeMs", () => {
    return dependencies.spritesClient.updateAccessPolicy(gatewayConnectionId, accessPolicy);
  });
  if (!scopeResult.ok) {
    return failure(buildError({
      code: scopeResult.error.code,
      stage: "scope",
      retryable: scopeResult.error.retryable,
      cleanup: await cleanupConnector(gatewayConnectionId, dependencies.spritesClient, timings),
      timings,
    }));
  }

  const verifyResult = await timings.time("verifyMs", () => {
    return dependencies.spritesClient.getConnection(gatewayConnectionId);
  });
  if (!verifyResult.ok) {
    return failure(buildError({
      code: verifyResult.error.code,
      stage: "verify",
      retryable: verifyResult.error.retryable,
      cleanup: await cleanupConnector(gatewayConnectionId, dependencies.spritesClient, timings),
      timings,
    }));
  }

  if (verifyResult.value === null || !policiesMatch(verifyResult.value.accessPolicy, accessPolicy)) {
    return failure(buildError({
      code: "policy_verification_failed",
      stage: "verify",
      retryable: false,
      cleanup: await cleanupConnector(gatewayConnectionId, dependencies.spritesClient, timings),
      timings,
    }));
  }

  return success({
    name: request.name,
    gatewayConnectionId,
    detailId: dashboardResult.value.detailId,
    accessPolicy,
    durations: timings.snapshot(),
  });
}

/**
 * Deletes a connector and confirms it is gone, so a failed delete can never be
 * mistaken for a clean teardown.
 *
 * @param connectionId Gateway connection id to delete.
 * @param spritesClient Sprites REST client used for the delete and the re-read.
 * @returns Success once the connector no longer resolves, otherwise a
 *   `cleanup_failed` error carrying the underlying cause.
 */
export async function deleteConnectorAndVerify(
  connectionId: string,
  spritesClient: SpriteConnectorsClient,
): Promise<Result<void, ConnectorCleanupError>> {
  const deleteResult = await spritesClient.deleteConnection(connectionId);
  if (!deleteResult.ok) {
    return failure(cleanupError(deleteResult.error.code, deleteResult.error.retryable));
  }

  const getResult = await spritesClient.getConnection(connectionId);
  if (!getResult.ok) {
    return failure(cleanupError(getResult.error.code, getResult.error.retryable));
  }
  if (getResult.value !== null) {
    return failure(cleanupError("connector_still_present", true));
  }

  return success(undefined);
}

function cleanupError(
  cause: ConnectorCleanupError["cause"],
  retryable: boolean,
): ConnectorCleanupError {
  return { code: "cleanup_failed", retryable, cause };
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
  timings: MintTimings;
}): ConnectorProvisionerError {
  return {
    code: params.code,
    stage: params.stage,
    retryable: params.retryable,
    dashboardOperation: params.dashboardOperation,
    dashboardShape: params.dashboardShape,
    message: errorMessage(params.code),
    cleanup: params.cleanup,
    durations: params.timings.snapshot(),
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

/** Backoff between list attempts; the dashboard create is not instantly visible. */
const LIST_AFTER_RETRY_DELAYS_MS = [250, 750, 1_500];

/**
 * Finds this attempt's connector in the Sprites connection list, retrying while
 * the freshly created connector is still not visible.
 *
 * @returns The connector, or `undefined` if it never appeared — which means an
 *   untracked connector may exist and needs operator reconciliation.
 */
async function findCreatedConnector(
  spritesClient: SpriteConnectorsClient,
  options: {
    name: string;
    sleep: (milliseconds: number) => Promise<void>;
    timings: MintTimings;
  },
): Promise<SpritesConnection | undefined> {
  const lookup = async (): Promise<SpritesConnection | undefined> => {
    const listResult = await spritesClient.listConnections();
    return listResult.ok ? findConnectorByName(listResult.value, options.name) : undefined;
  };

  return await options.timings.time("listAfterMs", async () => {
    let connector = await lookup();
    for (const retryDelay of LIST_AFTER_RETRY_DELAYS_MS) {
      if (connector !== undefined) {
        break;
      }
      await options.sleep(retryDelay);
      connector = await lookup();
    }
    return connector;
  });
}

async function cleanupConnector(
  connectionId: string,
  spritesClient: SpriteConnectorsClient,
  timings: MintTimings,
): Promise<CleanupStatus> {
  const result = await timings.time("cleanupMs", () => {
    return deleteConnectorAndVerify(connectionId, spritesClient);
  });
  return { attempted: true, succeeded: result.ok };
}

function defaultNameSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Handles a dashboard failure that happened after the create was submitted, so
 * the submit may or may not have produced a connector. Deletes the connector if
 * this attempt's name is found; otherwise reports that an untracked connector
 * may exist.
 */
async function reconcileAfterUncertainSubmit(params: {
  originalCode: ConnectorProvisionerErrorCode;
  dashboardOperation?: ConnectorProvisionerError["dashboardOperation"];
  dashboardShape?: ConnectorProvisionerError["dashboardShape"];
  request: MintConnectorRequest;
  dependencies: MintConnectorDependencies;
  sleep: (milliseconds: number) => Promise<void>;
  timings: MintTimings;
}): Promise<ConnectorProvisionerError> {
  const orphan = await findCreatedConnector(params.dependencies.spritesClient, {
    name: params.request.name,
    sleep: params.sleep,
    timings: params.timings,
  });
  if (orphan === undefined) {
    return buildError({
      code: "orphan_reconciliation_required",
      stage: "list_after",
      retryable: true,
      dashboardOperation: params.dashboardOperation,
      dashboardShape: params.dashboardShape,
      cleanup: NOT_ATTEMPTED,
      timings: params.timings,
    });
  }

  return buildError({
    code: params.originalCode,
    stage: "dashboard_create",
    retryable: false,
    dashboardOperation: params.dashboardOperation,
    dashboardShape: params.dashboardShape,
    cleanup: await cleanupConnector(
      orphan.id,
      params.dependencies.spritesClient,
      params.timings,
    ),
    timings: params.timings,
  });
}

/**
 * The per-attempt name suffix is the attribution key: only this call's dashboard
 * submit can have created a connector with this exact name, so a name match is
 * proof of ownership — no list diffing, and nothing else to corroborate.
 */
function findConnectorByName(
  connections: SpritesConnection[],
  name: string,
): SpritesConnection | undefined {
  return connections.find((connection) => {
    return connection.provider === "custom_api" && connection.providerAccountName === name;
  });
}
