import { failure, success, type Result } from "@repo/shared";
import type {
  AccessPolicy,
  SpritesConnection,
  SpriteConnectorsClient,
} from "@repo/sprites-client";
import type { MintConnectorRequest } from "./connector-provisioning.schema";
import type {
  CleanupStatus,
  ConnectorCleanupError,
  ConnectorProvisioningDurations,
  ConnectorProvisioningError,
  ConnectorProvisioningErrorCode,
  MintConnectorResult,
  ProvisioningStage,
} from "./connector-provisioning.types";

interface MintConnectorDependencies {
  spritesClient: SpriteConnectorsClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nameSuffix?: () => string;
}

const NOT_ATTEMPTED: CleanupStatus = Object.freeze({
  attempted: false,
  succeeded: false,
});

type StageDurations = Omit<ConnectorProvisioningDurations, "totalMs">;

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

  snapshot(): ConnectorProvisioningDurations {
    return { ...this.stages, totalMs: this.now() - this.startedAt };
  }
}

export async function mintConnector(
  callerRequest: MintConnectorRequest,
  dependencies: MintConnectorDependencies,
): Promise<Result<MintConnectorResult, ConnectorProvisioningError>> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const sleep = dependencies.sleep ?? delay;
  const nameSuffix = dependencies.nameSuffix ?? defaultNameSuffix;
  const request: MintConnectorRequest = {
    ...callerRequest,
    name: `${callerRequest.name}-${nameSuffix()}`,
  };
  const accessPolicy: AccessPolicy = {
    allowAll: false,
    spriteLabels: [...request.spriteLabels],
    ...(request.allowedEndpoints === undefined
      ? {}
      : { allowedEndpoints: [...request.allowedEndpoints] }),
  };
  const timings = new MintTimings(now);

  const createResult = await timings.time("createMs", () => {
    return dependencies.spritesClient.createCustomApiConnection({
      name: request.name,
      baseApiUrl: request.baseApiUrl,
      accessToken: request.token,
      testUrl: request.testUrl,
      authHeaderPrefix: request.headerPrefix,
      description: "Provisioned by Cloude",
      accessPolicy,
    });
  });
  if (!createResult.ok) {
    const outcomeIsUncertain = createResult.error.retryable
      || createResult.error.code === "sprites_response_invalid";
    if (!outcomeIsUncertain) {
      return failure(buildError({
        code: createResult.error.code,
        stage: "create",
        retryable: false,
        cleanup: NOT_ATTEMPTED,
        timings,
      }));
    }
    return failure(await reconcileAfterUncertainCreate({
      originalCode: createResult.error.code,
      name: request.name,
      dependencies,
      sleep,
      timings,
    }));
  }

  const createdConnector = createResult.value;
  const verifyResult = await timings.time("verifyMs", () => {
    return dependencies.spritesClient.getConnection(createdConnector.id);
  });
  if (!verifyResult.ok) {
    return failure(buildError({
      code: verifyResult.error.code,
      stage: "verify",
      retryable: verifyResult.error.retryable,
      cleanup: await cleanupConnector(createdConnector.id, dependencies.spritesClient, timings),
      timings,
    }));
  }

  if (!connectorMatches(verifyResult.value, {
    id: createdConnector.id,
    name: request.name,
    accessPolicy,
  })) {
    return failure(buildError({
      code: "connector_verification_failed",
      stage: "verify",
      retryable: false,
      cleanup: await cleanupConnector(createdConnector.id, dependencies.spritesClient, timings),
      timings,
    }));
  }

  return success({
    name: request.name,
    gatewayConnectionId: createdConnector.id,
    accessPolicy,
    durations: timings.snapshot(),
  });
}

/**
 * Deletes a connector and confirms it is gone.
 *
 * @param connectionId Gateway connection id to delete.
 * @param spritesClient Sprites REST client used for the delete and re-read.
 * @returns Success once the connector no longer resolves.
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

function connectorMatches(
  actual: SpritesConnection | null,
  expected: {
    id: string;
    name: string;
    accessPolicy: AccessPolicy;
  },
): boolean {
  return actual?.id === expected.id
    && actual.provider === "custom_api"
    && actual.providerAccountName === expected.name
    && policiesMatch(actual.accessPolicy, expected.accessPolicy);
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
  )
    && arraysEqual(
      [...(actual.allowedEndpoints ?? [])].sort(),
      [...(expected.allowedEndpoints ?? [])].sort(),
    )
    && arraysEqual(
      [...(actual.blockedEndpoints ?? [])].sort(),
      [...(expected.blockedEndpoints ?? [])].sort(),
    );
}

function buildError(params: {
  code: ConnectorProvisioningErrorCode;
  stage: ProvisioningStage;
  retryable: boolean;
  cleanup: CleanupStatus;
  timings: MintTimings;
}): ConnectorProvisioningError {
  return {
    code: params.code,
    stage: params.stage,
    retryable: params.retryable,
    message: errorMessage(params.code),
    cleanup: params.cleanup,
    durations: params.timings.snapshot(),
  };
}

function errorMessage(code: ConnectorProvisioningErrorCode): string {
  switch (code) {
    case "orphan_reconciliation_required":
      return "A connector may have been created without a usable response.";
    case "connector_verification_failed":
      return "The created connector could not be verified.";
    case "sprites_authentication_failed":
      return "Sprites API authentication failed.";
    case "sprites_rate_limited":
      return "Sprites API rate limited connector provisioning.";
    case "sprites_request_failed":
      return "A Sprites API request failed.";
    case "sprites_response_invalid":
      return "Sprites API returned an unexpected response.";
    case "cleanup_failed":
      return "The connector could not be removed.";
    default: {
      const exhaustiveCheck: never = code;
      throw new Error(`Unhandled connector provisioning error: ${exhaustiveCheck}`);
    }
  }
}

const RECONCILE_RETRY_DELAYS_MS = [250, 750, 1_500];

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

  return await options.timings.time("reconcileMs", async () => {
    let connector = await lookup();
    for (const retryDelay of RECONCILE_RETRY_DELAYS_MS) {
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
  if (result.ok) {
    return { attempted: true, succeeded: true };
  }
  return {
    attempted: true,
    succeeded: false,
    gatewayConnectionId: connectionId,
    error: result.error,
  };
}

function defaultNameSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function reconcileAfterUncertainCreate(params: {
  originalCode: ConnectorProvisioningErrorCode;
  name: string;
  dependencies: MintConnectorDependencies;
  sleep: (milliseconds: number) => Promise<void>;
  timings: MintTimings;
}): Promise<ConnectorProvisioningError> {
  const orphan = await findCreatedConnector(params.dependencies.spritesClient, {
    name: params.name,
    sleep: params.sleep,
    timings: params.timings,
  });
  if (orphan === undefined) {
    return buildError({
      code: "orphan_reconciliation_required",
      stage: "reconcile",
      retryable: true,
      cleanup: NOT_ATTEMPTED,
      timings: params.timings,
    });
  }

  return buildError({
    code: params.originalCode,
    stage: "create",
    retryable: false,
    cleanup: await cleanupConnector(
      orphan.id,
      params.dependencies.spritesClient,
      params.timings,
    ),
    timings: params.timings,
  });
}

function findConnectorByName(
  connections: SpritesConnection[],
  name: string,
): SpritesConnection | undefined {
  return connections.find((connection) => {
    return connection.provider === "custom_api" && connection.providerAccountName === name;
  });
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
